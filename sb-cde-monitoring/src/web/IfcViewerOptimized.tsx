import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MonitoringSnapshot } from "../shared/monitoring";
import { calculateConstructionProgress } from "../shared/construction-progress";
import type { BimModelId } from "../shared/models";
import {
  IfcStatusLegend,
  type FilterableDisplayState,
  type StatusModel,
} from "./IfcStatusLegend";

type Navigation = {
  fit: () => void;
  zoom: (factor: number) => void;
  view: (direction: "iso" | "top" | "front" | "right") => void;
};

type Stats = { elements: number; instances: number; triangles: number };
type GeometryRange = { start: number; count: number };
type DisplayState = "overview" | FilterableDisplayState | "hidden";

const HEADER_BYTES = 20;
const COLORS: Record<DisplayState, readonly [number, number, number, number]> = {
  overview: [201, 211, 220, 153],
  context: [129, 144, 157, 61],
  completed: [50, 212, 124, 255],
  inProgress: [49, 137, 232, 255],
  diagnostic: [226, 161, 60, 255],
  overdue: [226, 82, 74, 255],
  onSchedule: [59, 199, 123, 255],
  ahead: [72, 162, 228, 255],
  unknown: [154, 166, 178, 255],
  builtActual: [57, 123, 160, 255],
  builtPlan: [65, 123, 104, 255],
  notBuilt: [129, 144, 157, 61],
  hidden: [0, 0, 0, 0],
};

function packedColor(state: DisplayState) {
  const [red, green, blue, alpha] = COLORS[state];
  return (red | (green << 8) | (blue << 16) | (alpha << 24)) >>> 0;
}

function parseGeometry(buffer: ArrayBuffer) {
  if (buffer.byteLength < HEADER_BYTES) throw new Error("Кэш геометрии повреждён");
  const header = new DataView(buffer, 0, HEADER_BYTES);
  if (
    header.getUint8(0) !== 0x53 || header.getUint8(1) !== 0x42
    || header.getUint8(2) !== 0x56 || header.getUint8(3) !== 0x47
  ) throw new Error("Неизвестный формат геометрии");
  if (header.getUint32(4, true) !== 1) throw new Error("Версия геометрии не поддерживается");
  const vertexCount = header.getUint32(8, true);
  const indexCount = header.getUint32(12, true);
  const rangeCount = header.getUint32(16, true);
  const positionsBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  const normalsBytes = positionsBytes;
  const indicesBytes = indexCount * Uint32Array.BYTES_PER_ELEMENT;
  const expectedBytes = HEADER_BYTES + positionsBytes + normalsBytes + indicesBytes
    + rangeCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength !== expectedBytes) throw new Error("Кэш геометрии загружен не полностью");
  const positions = new Float32Array(buffer, HEADER_BYTES, vertexCount * 3);
  const normals = new Float32Array(buffer, HEADER_BYTES + positionsBytes, vertexCount * 3);
  const indices = new Uint32Array(buffer, HEADER_BYTES + positionsBytes + normalsBytes, indexCount);
  const descriptors = new Uint32Array(
    buffer, HEADER_BYTES + positionsBytes + normalsBytes + indicesBytes, rangeCount * 3,
  );
  const ranges = new Map<number, GeometryRange[]>();
  for (let index = 0; index < rangeCount; index += 1) {
    const offset = index * 3;
    const expressId = descriptors[offset];
    const range = { start: descriptors[offset + 1], count: descriptors[offset + 2] };
    ranges.set(expressId, [...(ranges.get(expressId) ?? []), range]);
  }
  const colors = new Uint8Array(vertexCount * 4);
  new Uint32Array(colors.buffer).fill(packedColor("overview"));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Uint8BufferAttribute(colors, 4, true));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return {
    geometry,
    ranges,
    stats: { elements: ranges.size, instances: rangeCount, triangles: indexCount / 3 },
  };
}

export function IfcViewer({ monitoring, modelId }: { monitoring: MonitoringSnapshot | null; modelId: BimModelId }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const navigation = useRef<Navigation | null>(null);
  const requestRender = useRef<(() => void) | null>(null);
  const rangesByExpressId = useRef<Map<number, GeometryRange[]>>(new Map());
  const colorAttribute = useRef<THREE.BufferAttribute | null>(null);
  const displayStateByExpressId = useRef<Map<number, DisplayState>>(new Map());
  const [status, setStatus] = useState("Загружаем геометрию…");
  const [error, setError] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [statusModel, setStatusModel] = useState<StatusModel>("execution");
  const [hiddenStates, setHiddenStates] = useState<Set<FilterableDisplayState>>(() => new Set(["notBuilt"]));

  const toggleDisplayState = (state: FilterableDisplayState) => {
    setHiddenStates((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  };

  useEffect(() => {
    const attribute = colorAttribute.current;
    const ranges = rangesByExpressId.current;
    if (!attribute || !ranges.size) return;
    const colorWords = new Uint32Array((attribute.array as Uint8Array).buffer);
    const workById = new Map(monitoring?.modelWorks.map((work) => [work.workId, work]) ?? []);
    const elementById = new Map(monitoring?.elements.map((element) => [element.expressId, element]) ?? []);
    let changed = false;
    for (const [expressId, elementRanges] of ranges) {
      const element = elementById.get(expressId);
      const work = element?.workId ? workById.get(element.workId) : null;
      let displayState: DisplayState = "overview";
      if (monitoring && statusModel === "construction") {
        const progress = work
          ? calculateConstructionProgress(work.actualFinish, work.plannedFinish, monitoring.selectedDate)
          : null;
        if (!progress?.visible) displayState = "notBuilt";
        else displayState = progress.source === "actual" ? "builtActual" : "builtPlan";
      } else if (monitoring && !work) displayState = "context";
      else if (work && statusModel === "problems") {
        if (work.status.deviation === "overdue") displayState = "overdue";
        else if (work.status.deviation === "on_schedule") displayState = "onSchedule";
        else if (work.status.deviation === "ahead") displayState = "ahead";
        else displayState = "unknown";
      } else if (work?.status.constructionStatus === "completed") {
        displayState = "completed";
      }
      else if (work?.status.constructionStatus === "in_progress") displayState = "inProgress";
      else if (work?.status.constructionStatus === "not_started") displayState = "context";
      else if (work) displayState = "diagnostic";
      if (displayState !== "overview" && hiddenStates.has(displayState)) {
        displayState = "hidden";
      }
      if (displayStateByExpressId.current.get(expressId) === displayState) continue;
      displayStateByExpressId.current.set(expressId, displayState);
      const color = packedColor(displayState);
      for (const range of elementRanges) colorWords.fill(color, range.start, range.start + range.count);
      changed = true;
    }
    if (changed) {
      attribute.needsUpdate = true;
      requestRender.current?.();
    }
  }, [monitoring, stats, statusModel, hiddenStates]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setStats(null);
    setError("");
    setStatus("Загружаем оптимизированную геометрию…");
    let active = true;
    let frame = 0;
    let loadedGeometry: THREE.BufferGeometry | null = null;
    const loadController = new AbortController();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b1118");
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.rotateSpeed = 0.65;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x252b31, 1.3));
    const light = new THREE.DirectionalLight(0xffffff, 1.5);
    light.position.set(40, 60, 30);
    scene.add(light);

    let renderQueued = false;
    const render = () => {
      renderQueued = false;
      renderer.render(scene, camera);
    };
    const scheduleRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      frame = requestAnimationFrame(render);
    };
    requestRender.current = scheduleRender;
    controls.addEventListener("change", scheduleRender);
    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      scheduleRender();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let center = new THREE.Vector3();
    let radius = 50;
    const setView = (direction: "iso" | "top" | "front" | "right") => {
      const vectors = {
        iso: new THREE.Vector3(1.15, .8, 1.15), top: new THREE.Vector3(0, 1, 0),
        front: new THREE.Vector3(0, .12, 1), right: new THREE.Vector3(1, .12, 0),
      };
      camera.up.set(0, direction === "top" ? 0 : 1, direction === "top" ? -1 : 0);
      camera.position.copy(center).add(vectors[direction].normalize().multiplyScalar(radius * 2.25));
      camera.near = Math.max(radius / 1000, .01);
      camera.far = Math.max(radius * 30, 1000);
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      scheduleRender();
    };
    navigation.current = {
      fit: () => setView("iso"),
      zoom: (factor) => {
        camera.position.copy(controls.target).add(camera.position.clone().sub(controls.target).multiplyScalar(factor));
        controls.update();
        scheduleRender();
      },
      view: setView,
    };

    const load = async () => {
      try {
        const started = performance.now();
        const response = await fetch(`/api/models/${modelId}/geometry`, { signal: loadController.signal });
        if (!response.ok) throw new Error(`Не удалось загрузить геометрию (${response.status})`);
        const data = await response.arrayBuffer();
        if (!active) return;
        setStatus("Передаём геометрию на GPU…");
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const parsed = parseGeometry(data);
        loadedGeometry = parsed.geometry;
        rangesByExpressId.current = parsed.ranges;
        colorAttribute.current = parsed.geometry.getAttribute("color") as THREE.BufferAttribute;
        displayStateByExpressId.current.clear();
        const material = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          vertexColors: true,
          roughness: .82,
          metalness: .02,
          transparent: true,
          alphaTest: .01,
          depthWrite: true,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(parsed.geometry, material);
        scene.add(mesh);
        const bounds = parsed.geometry.boundingBox!;
        const sphere = parsed.geometry.boundingSphere!;
        center = sphere.center;
        radius = Math.max(sphere.radius, 1);
        const grid = new THREE.GridHelper(radius * 4, 48, 0x41505f, 0x222d37);
        grid.position.set(center.x, bounds.min.y - radius * .004, center.z);
        scene.add(grid);
        setView("iso");
        if (active) {
          setStats(parsed.stats);
          setStatus(`Модель готова за ${((performance.now() - started) / 1000).toFixed(1)} с`);
        }
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        if (active) setError(reason instanceof Error ? reason.message : "Не удалось открыть модель");
      }
    };
    void load();
    return () => {
      active = false;
      loadController.abort();
      navigation.current = null;
      requestRender.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.removeEventListener("change", scheduleRender);
      controls.dispose();
      rangesByExpressId.current.clear();
      displayStateByExpressId.current.clear();
      colorAttribute.current = null;
      loadedGeometry?.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh && object.material instanceof THREE.Material) object.material.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [modelId]);

  return <div className="ifc-stage"><div ref={hostRef} className="ifc-canvas" />
    <div className="ifc-tools"><button onClick={() => navigation.current?.zoom(.82)}>+</button><button onClick={() => navigation.current?.zoom(1.22)}>−</button><button onClick={() => navigation.current?.fit()}>Сброс</button><button onClick={() => navigation.current?.view("top")}>Сверху</button><button onClick={() => navigation.current?.view("front")}>Спереди</button><button onClick={() => navigation.current?.view("right")}>Справа</button></div>
    {!stats && !error && <div className="ifc-loading"><span className="spinner"/><strong>{status}</strong></div>}
    {error && <div className="ifc-loading error"><strong>Модель не открылась</strong><span>{error}</span></div>}
    {stats && <div className="ifc-stats">
      <strong>{stats.elements.toLocaleString("ru-RU")} элементов</strong>
      {monitoring ? <>
        <label className="status-model-field">Статусная модель
          <select value={statusModel} onChange={(event) => setStatusModel(event.target.value as StatusModel)}>
            <option value="execution">Статус выполнения работ</option>
            <option value="problems">Статус проблем</option>
            <option value="construction">Ход строительства</option>
          </select>
        </label>
        <IfcStatusLegend statusModel={statusModel} hiddenStates={hiddenStates} onToggle={toggleDisplayState} />
      </> : <span className="ifc-legend-card context"><i />Прозрачность 40%</span>}
    </div>}
    <div className="ifc-help">ЛКМ — вращение · ПКМ — панорама · колесо — масштаб</div>
  </div>;
}

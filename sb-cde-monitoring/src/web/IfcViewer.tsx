import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { IfcAPI } from "web-ifc";
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
type Placement = { expressId: number; geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 };
type DisplayState = "overview" | FilterableDisplayState | "hidden";
type VisibleDisplayState = Exclude<DisplayState, "hidden">;

export function IfcViewer({ monitoring, modelId }: { monitoring: MonitoringSnapshot | null; modelId: BimModelId }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const navigation = useRef<Navigation | null>(null);
  const [status, setStatus] = useState("Загружаем IFC…");
  const [error, setError] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [statusModel, setStatusModel] = useState<StatusModel>("execution");
  const [hiddenStates, setHiddenStates] = useState<Set<FilterableDisplayState>>(() => new Set(["notBuilt"]));
  const meshesByExpressId = useRef<Map<number, THREE.Mesh[]>>(new Map());
  const displayStateByExpressId = useRef<Map<number, DisplayState>>(new Map());
  const materials = useRef<Record<VisibleDisplayState, THREE.MeshStandardMaterial> | null>(null);

  const toggleDisplayState = (state: FilterableDisplayState) => {
    setHiddenStates((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  };

  useEffect(() => {
    const palette = materials.current;
    if (!palette || !meshesByExpressId.current.size) return;
    const workById = new Map(monitoring?.modelWorks.map((work) => [work.workId, work]) ?? []);
    const elementById = new Map(monitoring?.elements.map((element) => [element.expressId, element]) ?? []);
    for (const [expressId, meshes] of meshesByExpressId.current) {
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
      } else if (work?.status.constructionStatus === "completed") displayState = "completed";
      else if (work?.status.constructionStatus === "in_progress") displayState = "inProgress";
      else if (work?.status.constructionStatus === "not_started") displayState = "context";
      else if (work) displayState = "diagnostic";
      if (displayState !== "overview" && hiddenStates.has(displayState)) {
        displayState = "hidden";
      }
      if (displayStateByExpressId.current.get(expressId) === displayState) continue;
      displayStateByExpressId.current.set(expressId, displayState);
      for (const mesh of meshes) {
        mesh.visible = displayState !== "hidden";
        if (displayState !== "hidden") mesh.material = palette[displayState];
      }
    }
  }, [monitoring, stats, statusModel, hiddenStates]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setStats(null);
    setError("");
    setStatus("Загружаем IFC…");
    let active = true;
    let frame = 0;
    let ifcApi: IfcAPI | null = null;
    let openedIfcModelId: number | null = null;
    const geometries = new Map<number, THREE.BufferGeometry>();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b1118");
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x252b31, 1.3));
    const light = new THREE.DirectionalLight(0xffffff, 1.5);
    light.position.set(40, 60, 30);
    scene.add(light);

    let center = new THREE.Vector3();
    let radius = 50;
    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
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
    };
    navigation.current = {
      fit: () => setView("iso"),
      zoom: (factor) => {
        camera.position.copy(controls.target).add(camera.position.clone().sub(controls.target).multiplyScalar(factor));
        controls.update();
      },
      view: setView,
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    const load = async () => {
      try {
        const response = await fetch(`/api/models/${modelId}/file`);
        if (!response.ok) throw new Error(`Не удалось загрузить IFC (${response.status})`);
        const data = new Uint8Array(await response.arrayBuffer());
        setStatus("Разбираем геометрию локально…");
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        ifcApi = new IfcAPI();
        ifcApi.SetWasmPath("/wasm/", true);
        await ifcApi.Init();
        openedIfcModelId = ifcApi.OpenModel(data, { COORDINATE_TO_ORIGIN: true, CIRCLE_SEGMENTS: 16 });
        const placements: Placement[] = [];
        let elements = 0;
        let instances = 0;
        let triangles = 0;
        ifcApi.StreamAllMeshes(openedIfcModelId, (mesh) => {
          elements += 1;
          for (let index = 0; index < mesh.geometries.size(); index += 1) {
            const placed = mesh.geometries.get(index);
            let geometry = geometries.get(placed.geometryExpressID);
            if (!geometry) {
              const source = ifcApi!.GetGeometry(openedIfcModelId!, placed.geometryExpressID);
              const interleaved = ifcApi!.GetVertexArray(source.GetVertexData(), source.GetVertexDataSize());
              const sourceIndices = ifcApi!.GetIndexArray(source.GetIndexData(), source.GetIndexDataSize());
              const count = interleaved.length / 6;
              const positions = new Float32Array(count * 3);
              const normals = new Float32Array(count * 3);
              for (let vertex = 0; vertex < count; vertex += 1) {
                positions.set(interleaved.slice(vertex * 6, vertex * 6 + 3), vertex * 3);
                normals.set(interleaved.slice(vertex * 6 + 3, vertex * 6 + 6), vertex * 3);
              }
              geometry = new THREE.BufferGeometry();
              geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
              geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
              geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(sourceIndices), 1));
              geometries.set(placed.geometryExpressID, geometry);
              source.delete();
            }
            placements.push({ expressId: mesh.expressID, geometry, matrix: new THREE.Matrix4().fromArray(placed.flatTransformation) });
            instances += 1;
            triangles += (geometry.getIndex()?.count ?? 0) / 3;
          }
        });
        const overviewMaterial = new THREE.MeshStandardMaterial({
          color: 0xc9d3dc, roughness: .82, metalness: .02, transparent: true,
          opacity: .6, depthWrite: false, side: THREE.DoubleSide,
        });
        const contextMaterial = new THREE.MeshStandardMaterial({
          color: 0x81909d, roughness: .86, metalness: .01, transparent: true,
          opacity: .24, depthWrite: false, side: THREE.DoubleSide,
        });
        const completedMaterial = new THREE.MeshStandardMaterial({ color: 0x32d47c, roughness: .78, side: THREE.DoubleSide });
        const inProgressMaterial = new THREE.MeshStandardMaterial({ color: 0x3189e8, roughness: .78, side: THREE.DoubleSide });
        const diagnosticMaterial = new THREE.MeshStandardMaterial({ color: 0xe2a13c, roughness: .8, side: THREE.DoubleSide });
        const overdueMaterial = new THREE.MeshStandardMaterial({ color: 0xe2524a, roughness: .78, side: THREE.DoubleSide });
        const onScheduleMaterial = new THREE.MeshStandardMaterial({ color: 0x3bc77b, roughness: .78, side: THREE.DoubleSide });
        const aheadMaterial = new THREE.MeshStandardMaterial({ color: 0x48a2e4, roughness: .78, side: THREE.DoubleSide });
        const unknownMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa6b2, roughness: .82, side: THREE.DoubleSide });
        const builtActualMaterial = new THREE.MeshStandardMaterial({ color: 0x397ba0, roughness: .78, side: THREE.DoubleSide });
        const builtPlanMaterial = new THREE.MeshStandardMaterial({ color: 0x417b68, roughness: .78, side: THREE.DoubleSide });
        const notBuiltMaterial = new THREE.MeshStandardMaterial({
          color: 0x81909d, roughness: .86, metalness: .01, transparent: true,
          opacity: .24, depthWrite: false, side: THREE.DoubleSide,
        });
        materials.current = { overview: overviewMaterial, context: contextMaterial, completed: completedMaterial, inProgress: inProgressMaterial, diagnostic: diagnosticMaterial, overdue: overdueMaterial, onSchedule: onScheduleMaterial, ahead: aheadMaterial, unknown: unknownMaterial, builtActual: builtActualMaterial, builtPlan: builtPlanMaterial, notBuilt: notBuiltMaterial };
        const group = new THREE.Group();
        for (const placement of placements) {
          const mesh = new THREE.Mesh(placement.geometry, overviewMaterial);
          mesh.applyMatrix4(placement.matrix);
          mesh.frustumCulled = false;
          group.add(mesh);
          meshesByExpressId.current.set(placement.expressId, [
            ...(meshesByExpressId.current.get(placement.expressId) ?? []),
            mesh,
          ]);
        }
        scene.add(group);
        const bounds = new THREE.Box3().setFromObject(group);
        const sphere = bounds.getBoundingSphere(new THREE.Sphere());
        center = sphere.center;
        radius = Math.max(sphere.radius, 1);
        const grid = new THREE.GridHelper(radius * 4, 48, 0x41505f, 0x222d37);
        grid.position.set(center.x, bounds.min.y - radius * .004, center.z);
        scene.add(grid);
        setView("iso");
        if (active) { setStats({ elements, instances, triangles: Math.round(triangles) }); setStatus("Модель готова"); }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Не удалось открыть IFC");
      }
    };
    void load();
    return () => {
      active = false;
      navigation.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      meshesByExpressId.current.clear();
      displayStateByExpressId.current.clear();
      if (materials.current) Object.values(materials.current).forEach((material) => material.dispose());
      materials.current = null;
      if (ifcApi && openedIfcModelId !== null && ifcApi.IsModelOpen(openedIfcModelId)) ifcApi.CloseModel(openedIfcModelId);
      ifcApi?.Dispose();
      geometries.forEach((geometry) => geometry.dispose());
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


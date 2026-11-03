import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { IfcAPI } from "web-ifc";
import {
  IfcStatusCatalogSchema,
  IFC_TIMELINE_STEP_DAYS,
  buildTimelineElementStatuses,
  dateAtTimelineOffset,
  getIfcTimelineRange,
  getIfcTimelineScale,
  getVisualizedIfcWorks,
  timelineOffset,
  type IfcKfoBindings,
  type IfcStatusCounts,
  type IfcStatusCatalog,
  type IfcVisualStatus,
} from "../shared/ifc-status.js";

const MODEL_URL = "/models/RD_KR_04-08.ifc";
const BINDINGS_URL = "/api/ifc-kfo/bindings";
const STATUSES_URL = "/api/ifc-kfo/statuses";

type ViewerStats = {
  elements: number;
  instances: number;
  triangles: number;
};

type ViewerNavigation = {
  fit: () => void;
  zoom: (factor: number) => void;
  view: (direction: "iso" | "top" | "front" | "right") => void;
};

type GeometryPlacement = {
  expressId: number;
  geometryId: number;
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
};

type GeometryBatch = {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  matrices: THREE.Matrix4[];
};

type TimelineRange = ReturnType<typeof getIfcTimelineRange>;
const EMPTY_STATUS_COUNTS: IfcStatusCounts = {
  completed: 0,
  in_progress: 0,
  planned: 0,
  unknown: 0,
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function formatMonth(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

export default function IfcViewer() {
  const canvasHost = useRef<HTMLDivElement>(null);
  const navigation = useRef<ViewerNavigation | null>(null);
  const applyTimelineDate = useRef<((date: string) => void) | null>(null);
  const [status, setStatus] = useState("Подготавливаем IFC-движок…");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [statusCatalog, setStatusCatalog] = useState<IfcStatusCatalog | null>(null);
  const [statusCounts, setStatusCounts] = useState<IfcStatusCounts>(EMPTY_STATUS_COUNTS);
  const [timeline, setTimeline] = useState<TimelineRange | null>(null);
  const [selectedDate, setSelectedDate] = useState("");

  useEffect(() => {
    if (selectedDate) applyTimelineDate.current?.(selectedDate);
  }, [selectedDate]);

  useEffect(() => {
    const host = canvasHost.current;
    if (!host) return;

    let active = true;
    let frame = 0;
    let modelId: number | null = null;
    let ifcApi: IfcAPI | null = null;
    let model: THREE.Group | null = null;
    let ground: THREE.GridHelper | null = null;
    const geometryCache = new Map<number, THREE.BufferGeometry>();
    const statusMaterials = new Map<IfcVisualStatus, THREE.MeshStandardMaterial>();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#17191d");
    scene.fog = new THREE.FogExp2("#17191d", 0.00035);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100000);
    camera.up.set(0, 1, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.82;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;

    scene.add(new THREE.HemisphereLight(0xe7f2ff, 0x24201c, 0.85));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(30, -40, 65);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x8eabff, 0.42);
    fillLight.position.set(-45, 20, 30);
    scene.add(fillLight);

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
      const directions = {
        iso: new THREE.Vector3(1.15, 0.8, 1.15),
        top: new THREE.Vector3(0, 1, 0),
        front: new THREE.Vector3(0, 0.12, 1),
        right: new THREE.Vector3(1, 0.12, 0),
      };
      const offset = directions[direction].normalize().multiplyScalar(radius * 2.25);
      camera.up.set(0, direction === "top" ? 0 : 1, direction === "top" ? -1 : 0);
      camera.position.copy(center).add(offset);
      camera.near = Math.max(radius / 1000, 0.01);
      camera.far = Math.max(radius * 30, 1000);
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
    };

    const zoom = (factor: number) => {
      const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor);
      camera.position.copy(controls.target).add(offset);
      controls.update();
    };

    navigation.current = { fit: () => setView("iso"), zoom, view: setView };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    const loadJson = async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Не удалось загрузить ${url} (${response.status})`);
      return response.json() as Promise<unknown>;
    };

    const loadModel = async () => {
      try {
        setStatus("Загружаем модель, привязки и статусы…");
        const [modelResponse, rawBindings, rawCatalog] = await Promise.all([
          fetch(MODEL_URL),
          loadJson(BINDINGS_URL),
          loadJson(STATUSES_URL),
        ]);
        if (!modelResponse.ok)
          throw new Error(`Не удалось загрузить IFC (${modelResponse.status})`);
        const data = new Uint8Array(await modelResponse.arrayBuffer());
        const bindings = rawBindings as IfcKfoBindings;
        const catalog = IfcStatusCatalogSchema.parse(rawCatalog);
        const works = getVisualizedIfcWorks(bindings);
        const categorizedExpressIds = new Set(
          works.flatMap((work) => work.elements.map((element) => element.expressId)),
        );
        const range = getIfcTimelineRange(bindings);
        if (!active) return;
        setStatusCatalog(catalog);
        setTimeline(range);
        setSelectedDate(range.statusDate);

        setStatus("Разбираем IFC и строим геометрию…");
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        ifcApi = new IfcAPI();
        ifcApi.SetWasmPath("/wasm/", true);
        await ifcApi.Init();
        modelId = ifcApi.OpenModel(data, {
          COORDINATE_TO_ORIGIN: true,
          CIRCLE_SEGMENTS: 16,
        });

        for (const definition of catalog.statuses) {
          statusMaterials.set(definition.id, new THREE.MeshStandardMaterial({
            color: new THREE.Color(definition.color),
            metalness: 0.02,
            roughness: 0.78,
            transparent: definition.opacity < 1,
            opacity: definition.opacity,
            depthWrite: definition.opacity >= 0.98,
            side: THREE.DoubleSide,
          }));
        }

        const placements: GeometryPlacement[] = [];
        const visibleExpressIds = new Set<number>();
        let elements = 0;
        let instances = 0;
        let triangles = 0;

        ifcApi.StreamAllMeshes(modelId, (flatMesh) => {
          if (!categorizedExpressIds.has(flatMesh.expressID)) return;
          elements += 1;
          visibleExpressIds.add(flatMesh.expressID);
          for (let index = 0; index < flatMesh.geometries.size(); index += 1) {
            const placed = flatMesh.geometries.get(index);
            let geometry = geometryCache.get(placed.geometryExpressID);
            if (!geometry) {
              const ifcGeometry = ifcApi!.GetGeometry(modelId!, placed.geometryExpressID);
              const interleaved = ifcApi!.GetVertexArray(
                ifcGeometry.GetVertexData(),
                ifcGeometry.GetVertexDataSize(),
              );
              const sourceIndices = ifcApi!.GetIndexArray(
                ifcGeometry.GetIndexData(),
                ifcGeometry.GetIndexDataSize(),
              );
              const vertexCount = interleaved.length / 6;
              const positions = new Float32Array(vertexCount * 3);
              const normals = new Float32Array(vertexCount * 3);
              for (let vertex = 0; vertex < vertexCount; vertex += 1) {
                const source = vertex * 6;
                const target = vertex * 3;
                positions[target] = interleaved[source];
                positions[target + 1] = interleaved[source + 1];
                positions[target + 2] = interleaved[source + 2];
                normals[target] = interleaved[source + 3];
                normals[target + 1] = interleaved[source + 4];
                normals[target + 2] = interleaved[source + 5];
              }
              geometry = new THREE.BufferGeometry();
              geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
              geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
              geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(sourceIndices), 1));
              geometry.computeBoundingBox();
              geometryCache.set(placed.geometryExpressID, geometry);
              ifcGeometry.delete();
            }

            placements.push({
              expressId: flatMesh.expressID,
              geometryId: placed.geometryExpressID,
              geometry,
              matrix: new THREE.Matrix4().fromArray(placed.flatTransformation),
            });
            instances += 1;
            triangles += (geometry.getIndex()?.count ?? 0) / 3;
          }
        });

        model = new THREE.Group();
        model.name = "RD_KR_04-08-status-view";
        scene.add(model);

        const renderStatuses = (date: string) => {
          if (!model) return;
          model.clear();
          const { statusByExpressId, counts } = buildTimelineElementStatuses(
            works,
            visibleExpressIds,
            date,
            bindings.statusAsOf,
            catalog.defaultStatus,
          );

          const batches = new Map<string, GeometryBatch>();
          for (const placement of placements) {
            const visualStatus = statusByExpressId.get(placement.expressId) ?? catalog.defaultStatus;
            const batchKey = `${placement.geometryId}:${visualStatus}`;
            let batch = batches.get(batchKey);
            if (!batch) {
              batch = {
                geometry: placement.geometry,
                material: statusMaterials.get(visualStatus)!,
                matrices: [],
              };
              batches.set(batchKey, batch);
            }
            batch.matrices.push(placement.matrix);
          }

          for (const batch of batches.values()) {
            const mesh = new THREE.InstancedMesh(
              batch.geometry,
              batch.material,
              batch.matrices.length,
            );
            batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
            mesh.instanceMatrix.needsUpdate = true;
            mesh.frustumCulled = false;
            model.add(mesh);
          }
          if (active) setStatusCounts(counts);
        };

        applyTimelineDate.current = renderStatuses;
        renderStatuses(range.statusDate);

        const bounds = new THREE.Box3().setFromObject(model);
        const sphere = bounds.getBoundingSphere(new THREE.Sphere());
        center = sphere.center;
        radius = Math.max(sphere.radius, 1);

        ground = new THREE.GridHelper(radius * 4, 48, 0x4b5260, 0x2c3139);
        ground.position.set(center.x, bounds.min.y - radius * 0.004, center.z);
        scene.add(ground);
        scene.fog = new THREE.FogExp2("#17191d", 0.72 / (radius * 6));
        setView("iso");

        if (active) {
          setStats({ elements, instances, triangles: Math.round(triangles) });
          setStatus("Модель готова");
        }
      } catch (reason) {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Не удалось открыть IFC");
          setStatus("Ошибка загрузки");
        }
      }
    };

    void loadModel();

    return () => {
      active = false;
      navigation.current = null;
      applyTimelineDate.current = null;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      controls.dispose();
      if (ifcApi && modelId !== null && ifcApi.IsModelOpen(modelId)) ifcApi.CloseModel(modelId);
      ifcApi?.Dispose();
      geometryCache.forEach((geometry) => geometry.dispose());
      statusMaterials.forEach((material) => material.dispose());
      ground?.geometry.dispose();
      if (Array.isArray(ground?.material)) ground.material.forEach((item) => item.dispose());
      else ground?.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const selectedOffset = timeline && selectedDate
    ? Math.min(timeline.dayCount, timelineOffset(timeline.start, selectedDate))
    : 0;
  const timelineScale = timeline
    ? getIfcTimelineScale(timeline.start, timeline.end)
    : { months: [], weeks: [] };
  const offsetPercent = (offset: number) =>
    timeline?.dayCount ? (offset / timeline.dayCount) * 100 : 0;

  return (
    <div className="shell ifc-shell">
      <header className="ifc-header">
        <div className="brand-mark ifc-brand-mark" aria-hidden="true">3D</div>
        <div className="brand">
          <strong>Мониторинг объекта</strong>
          <span>Сводная модель и статусы работ на временной шкале</span>
        </div>
        <div className="surface-context">RD_KR_04-08.ifc · только просмотр</div>
        <div className="revision">
          {stats ? `${stats.elements.toLocaleString("ru-RU")} элементов` : status}
          <span className="readonly">Навигация 3D</span>
        </div>
      </header>

      <main className="ifc-workspace">
        <div ref={canvasHost} className="ifc-canvas" aria-label="Трёхмерная IFC-модель" />

        <div className="ifc-navigation" aria-label="Инструменты навигации">
          <button onClick={() => navigation.current?.zoom(0.82)} title="Приблизить">+</button>
          <button onClick={() => navigation.current?.zoom(1.22)} title="Отдалить">−</button>
          <span />
          <button onClick={() => navigation.current?.fit()} title="Показать модель целиком">⌂</button>
          <button className="view-label" onClick={() => navigation.current?.view("iso")}>ISO</button>
          <button className="view-label" onClick={() => navigation.current?.view("top")}>Сверху</button>
          <button className="view-label" onClick={() => navigation.current?.view("front")}>Спереди</button>
          <button className="view-label" onClick={() => navigation.current?.view("right")}>Справа</button>
        </div>

        {statusCatalog && stats && (
          <div className="ifc-status-legend" aria-label="Легенда статусов">
            {statusCatalog.statuses
              .slice()
              .sort((left, right) => left.order - right.order)
              .map((definition) => (
                <div key={definition.id}>
                  <i style={{
                    backgroundColor: definition.color,
                    opacity: definition.opacity,
                  }} />
                  <span>{definition.label}</span>
                  <b>{statusCounts[definition.id].toLocaleString("ru-RU")}</b>
                </div>
              ))}
          </div>
        )}

        {timeline && selectedDate && stats && (
          <section className="ifc-timeline" aria-label="Временная шкала статусов">
            <div className="ifc-timeline-heading">
              <span>Статус на дату</span>
              <strong>{formatDate(selectedDate)}</strong>
              <button
                type="button"
                disabled={selectedDate === timeline.statusDate}
                onClick={() => setSelectedDate(timeline.statusDate)}
              >
                Дата XML
              </button>
            </div>
            <div className="ifc-timeline-slider">
              <input
                type="range"
                min={0}
                max={timeline.dayCount}
                step={IFC_TIMELINE_STEP_DAYS}
                value={selectedOffset}
                onChange={(event) =>
                  setSelectedDate(dateAtTimelineOffset(timeline.start, Number(event.target.value)))}
                aria-label="Дата отображения статусов"
              />
              <div className="ifc-timeline-week-ticks" aria-hidden="true">
                {timelineScale.weeks.map((tick) => (
                  <i
                    key={tick.date}
                    style={{ left: `${offsetPercent(tick.offset)}%` }}
                  />
                ))}
              </div>
            </div>
            <div className="ifc-timeline-months" aria-hidden="true">
              {timelineScale.months.map((month, index) => {
                const nextOffset = timelineScale.months[index + 1]?.offset ?? timeline.dayCount;
                return (
                  <span
                    key={month.date}
                    style={{
                      left: `${offsetPercent(month.offset)}%`,
                      width: `${offsetPercent(nextOffset - month.offset)}%`,
                    }}
                    title={formatDate(month.date)}
                  >
                    {formatMonth(month.date)}
                  </span>
                );
              })}
            </div>
            <div className="ifc-timeline-range">
              <span>{formatDate(timeline.start)}</span>
              <span>Дата XML: {formatDate(timeline.statusDate)}</span>
              <span>{formatDate(timeline.end)}</span>
            </div>
          </section>
        )}

        {!stats && !error && (
          <div className="ifc-loading">
            <span className="ifc-spinner" />
            <strong>{status}</strong>
            <small>Модель и статусы обрабатываются локально в браузере</small>
          </div>
        )}

        {error && (
          <div className="ifc-loading ifc-failure">
            <strong>Модель не открылась</strong>
            <small>{error}</small>
          </div>
        )}

        <div className="ifc-help">
          <b>ЛКМ</b> вращение <b>ПКМ</b> панорама <b>Колесо</b> масштаб
        </div>

        {stats && (
          <div className="ifc-stats">
            <span><b>{stats.elements.toLocaleString("ru-RU")}</b> элементов</span>
            <span><b>{stats.instances.toLocaleString("ru-RU")}</b> геометрий</span>
            <span><b>{stats.triangles.toLocaleString("ru-RU")}</b> треугольников</span>
          </div>
        )}
      </main>

      <footer>
        <span>Мониторинг объекта</span>
        <span>Статусная окраска · временная шкала · read-only</span>
        <span>Источник статусов: локальный XML-график</span>
      </footer>
    </div>
  );
}

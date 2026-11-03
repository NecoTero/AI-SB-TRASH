import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getBezierPath,
  useInternalNode,
  useNodesState,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeProps,
  type OnMove,
  type ReactFlowInstance,
  type ReactFlowProps,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  ChangeOperation,
  Entity,
  Project,
  Relation,
  Task,
  TaskDraft,
} from "../shared/model";

const labels: Record<string, string> = {
  system: "Система",
  module: "Модуль",
  feature: "Функциональность",
  zone: "Зона",
  document: "Документ",
  document_section: "Раздел документа",
  file: "Файл",
  data_artifact: "Артефакт данных",
  data_field: "Поле данных",
  source_system: "Источник",
  api: "API",
  script: "Скрипт",
  process: "Процесс",
  requirement: "Требование",
  decision: "Решение",
  context: "Контекст",
  logical_artifact: "Логический артефакт",
  artifact: "Файл",
  artifact_version: "Версия файла",
  reference: "Справочник",
  rule: "Правило",
  subject_entity: "Предметная сущность",
  data: "Показатель",
  state: "Состояние",
};
const relationLabels: Record<string, string> = {
  contains: "содержит", part_of: "входит в", produces: "формирует",
  consumes: "использует", reads_from: "читает из", writes_to: "записывает в",
  transforms_to: "преобразует в", provides: "предоставляет", calls: "вызывает",
  depends_on: "зависит от", maps_to: "сопоставляется с", described_by: "описан",
  justified_by: "обоснован", related_to: "связан с", representedBy: "представлен",
  hasVersion: "имеет версию", hasMetric: "имеет показатель", hasStatus: "имеет статус",
  implemented_by: "реализован файлом",
};
const typeColors = [
  "#7dcfff",
  "#bb9af7",
  "#9ece6a",
  "#e0af68",
  "#f7768e",
  "#73daca",
  "#ff9e64",
  "#c0caf5",
];
type ViewMode = "current" | "draft";
type NodeShape = "component" | "process" | "document" | "data" | "reference";
type GraphNodeData = {
  label: string;
  color: string;
  shape: NodeShape;
  size: number;
  dimmed: boolean;
  related: boolean;
};
type GraphNode = Node<GraphNodeData, "knowledge">;
type Vector = { x: number; y: number };
type ViewportMotion = { viewport: Viewport; at: number; velocity: Vector };
const RELATED_COLLISION_RADIUS = 190;
const UNRELATED_COLLISION_RADIUS = 96;
const UNRELATED_DRAG_RADIUS = 110;
function relationPairKey(first: string, second: string) {
  return first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`;
}
function connectedComponentIds(startId: string, relations: Relation[]) {
  const result = new Set([startId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of relations) {
      if (result.has(relation.sourceId) && !result.has(relation.targetId)) {
        result.add(relation.targetId);
        changed = true;
      } else if (
        result.has(relation.targetId) &&
        !result.has(relation.sourceId)
      ) {
        result.add(relation.sourceId);
        changed = true;
      }
    }
  }
  return result;
}

const typeColorOverrides: Record<string, string> = {
  process: "#ff9e64", script: "#ff9e64", api: "#bb9af7",
  document: "#7dcfff", document_section: "#89ddff", file: "#7dcfff",
  artifact: "#7dcfff", artifact_version: "#89ddff", data_artifact: "#9ece6a",
  data_field: "#73daca", data: "#9ece6a", logical_artifact: "#9ece6a",
  module: "#bb9af7", system: "#c0caf5", source_system: "#c0caf5",
  feature: "#e0af68", decision: "#f7768e", requirement: "#f7768e",
};
function colorFor(type: string) {
  if (typeColorOverrides[type]) return typeColorOverrides[type];
  let hash = 0;
  for (const char of type) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return typeColors[Math.abs(hash) % typeColors.length];
}
function shapeFor(type: string): NodeShape {
  if (["process", "script", "api"].includes(type)) return "process";
  if (["document", "document_section", "file", "artifact", "artifact_version"].includes(type)) return "document";
  if (["data_artifact", "data_field", "data", "logical_artifact", "subject_entity", "state"].includes(type)) return "data";
  if (["reference", "rule", "requirement", "decision"].includes(type)) return "reference";
  return "component";
}
function relationKind(type: string) {
  if (["produces", "consumes", "reads_from", "writes_to", "transforms_to", "provides", "maps_to"].includes(type)) return "flow";
  if (["contains", "part_of", "representedBy", "hasVersion"].includes(type)) return "structure";
  return "dependency";
}
function projectDraft(map: Project["currentMap"], draft: TaskDraft | null) {
  if (!draft) return { entities: [], relations: [] };
  let entities = [...map.entities],
    relations = [...map.relations];
  for (const operation of draft.operations as ChangeOperation[]) {
    switch (operation.op) {
      case "createEntity":
        if (!entities.some((e) => e.id === operation.entity.id))
          entities.push(operation.entity);
        break;
      case "updateEntity":
        entities = entities.map((e) =>
          e.id === operation.entityId
            ? ({ ...e, ...operation.patch } as Entity)
            : e,
        );
        break;
      case "archiveEntity":
        entities = entities.filter((e) => e.id !== operation.entityId);
        break;
      case "createRelation":
        if (!relations.some((r) => r.id === operation.relation.id))
          relations.push(operation.relation);
        break;
      case "updateRelation":
        relations = relations.map((r) =>
          r.id === operation.relationId
            ? ({ ...r, ...operation.patch } as Relation)
            : r,
        );
        break;
      case "archiveRelation":
        relations = relations.filter((r) => r.id !== operation.relationId);
        break;
    }
  }
  return { entities, relations };
}

function forceLayout(entities: Entity[], relations: Relation[]) {
  const count = entities.length;
  if (!count) return new Map<string, { x: number; y: number }>();
  const width = Math.max(900, Math.sqrt(count) * 280),
    height = Math.max(620, Math.sqrt(count) * 210);
  const points = entities.map((entity, index) => {
    const angle = (index / count) * Math.PI * 2;
    let hash = 0;
    for (const char of entity.id) hash = (hash * 33 + char.charCodeAt(0)) | 0;
    const jitter = (Math.abs(hash) % 90) - 45;
    return {
      id: entity.id,
      x: width / 2 + Math.cos(angle) * (width * 0.3 + jitter),
      y: height / 2 + Math.sin(angle) * (height * 0.3 + jitter),
      vx: 0,
      vy: 0,
    };
  });
  const byId = new Map(points.map((point) => [point.id, point]));
  for (let step = 0; step < 240; step++) {
    for (let i = 0; i < count; i++)
      for (let j = i + 1; j < count; j++) {
        const a = points[i],
          b = points[j];
        let dx = a.x - b.x,
          dy = a.y - b.y;
        const distanceSquared = Math.max(dx * dx + dy * dy, 80),
          force = 2600 / distanceSquared,
          distance = Math.sqrt(distanceSquared);
        dx /= distance;
        dy /= distance;
        a.vx += dx * force;
        a.vy += dy * force;
        b.vx -= dx * force;
        b.vy -= dy * force;
      }
    for (const relation of relations) {
      const a = byId.get(relation.sourceId),
        b = byId.get(relation.targetId);
      if (!a || !b) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1),
        force = (distance - 145) * 0.0028;
      a.vx += (dx / distance) * force;
      a.vy += (dy / distance) * force;
      b.vx -= (dx / distance) * force;
      b.vy -= (dy / distance) * force;
    }
    for (const point of points) {
      point.vx += (width / 2 - point.x) * 0.0008;
      point.vy += (height / 2 - point.y) * 0.0008;
      point.vx *= 0.82;
      point.vy *= 0.82;
      point.x = Math.max(80, Math.min(width - 80, point.x + point.vx));
      point.y = Math.max(60, Math.min(height - 60, point.y + point.vy));
    }
  }
  return new Map(points.map((point) => [point.id, { x: point.x, y: point.y }]));
}

const KnowledgeNode = memo(({ data, selected }: NodeProps<GraphNode>) => (
  <div
    className={
      "knowledge-node" +
      (selected ? " selected" : "") +
      (data.dimmed ? " dimmed" : "") +
      (data.related ? " related" : "") +
      " shape-" + data.shape
    }
    style={
      {
        "--node-color": data.color,
        "--node-size": data.size + "px",
      } as CSSProperties
    }
  >
    <Handle
      type="target"
      position={Position.Left}
      className="knowledge-handle"
      isConnectable={false}
    />
    <span className="node-halo" />
    <span className="node-dot" />
    <span className="node-label">{data.label}</span>
    <Handle
      type="source"
      position={Position.Right}
      className="knowledge-handle"
      isConnectable={false}
    />
  </div>
));
const nodeTypes = { knowledge: KnowledgeNode };

function nodeCircle(node: InternalNode<GraphNode>) {
  const width = node.measured.width ?? 16,
    height = node.measured.height ?? 16;
  return {
    x: node.internals.positionAbsolute.x + width / 2,
    y: node.internals.positionAbsolute.y + height / 2,
    radius: Math.max(Math.min(width, height) / 2, 7),
  };
}
function edgeSide(dx: number, dy: number) {
  return Math.abs(dx) >= Math.abs(dy)
    ? dx >= 0
      ? Position.Right
      : Position.Left
    : dy >= 0
      ? Position.Bottom
      : Position.Top;
}
function floatingEdgeParams(
  source: InternalNode<GraphNode>,
  target: InternalNode<GraphNode>,
) {
  const a = nodeCircle(source),
    b = nodeCircle(target),
    dx = b.x - a.x,
    dy = b.y - a.y,
    distance = Math.max(Math.hypot(dx, dy), 1),
    ux = dx / distance,
    uy = dy / distance;
  return {
    sourceX: a.x + ux * a.radius,
    sourceY: a.y + uy * a.radius,
    targetX: b.x - ux * b.radius,
    targetY: b.y - uy * b.radius,
    sourcePosition: edgeSide(dx, dy),
    targetPosition: edgeSide(-dx, -dy),
  };
}
const FloatingEdge = memo(
  ({
    id,
    source,
    target,
    label,
    labelStyle,
    labelShowBg,
    labelBgStyle,
    labelBgPadding,
    labelBgBorderRadius,
    style,
    markerStart,
    markerEnd,
    interactionWidth,
  }: EdgeProps) => {
    const sourceNode = useInternalNode<GraphNode>(source),
      targetNode = useInternalNode<GraphNode>(target);
    if (!sourceNode || !targetNode) return null;
    const [path, labelX, labelY] = getBezierPath(
      floatingEdgeParams(sourceNode, targetNode),
    );
    return (
      <BaseEdge
        id={id}
        path={path}
        labelX={labelX}
        labelY={labelY}
        label={label}
        labelStyle={labelStyle}
        labelShowBg={labelShowBg}
        labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding}
        labelBgBorderRadius={labelBgBorderRadius}
        style={style}
        markerStart={markerStart}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
      />
    );
  },
);
const edgeTypes = { floating: FloatingEdge };

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [selected, setSelected] = useState<Entity | null>(null);
  const [selectedRelation, setSelectedRelation] = useState<Relation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("current");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [flow, setFlow] = useState<ReactFlowInstance<GraphNode, Edge> | null>(
    null,
  );
  const flowRef = useRef<ReactFlowInstance<GraphNode, Edge> | null>(null);
  const layoutScopeRef = useRef("current");
  const manualPositions = useRef(new Map<string, Vector>());
  const nodeVelocities = useRef(new Map<string, Vector>());
  const physicsActiveIds = useRef(new Set<string>());
  const nodePhysicsFrame = useRef<number | null>(null);
  const nodeSettleDeadline = useRef(0);
  const draggedNodeId = useRef<string | null>(null);
  const lastDrag = useRef<{
    id: string;
    position: Vector;
    at: number;
    velocity: Vector;
  } | null>(null);
  const viewportMotion = useRef<ViewportMotion | null>(null);
  const viewportInertiaFrame = useRef<number | null>(null);
  useEffect(() => {
    fetch("/api/project")
      .then((r) => {
        if (!r.ok) throw Error("API недоступен");
        return r.json();
      })
      .then((value: Project) => {
        setProject(value);
        if (value.tasks[0]) setTaskId(value.tasks[0].taskId);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(
    () => () => {
      if (nodePhysicsFrame.current !== null)
        cancelAnimationFrame(nodePhysicsFrame.current);
      if (viewportInertiaFrame.current !== null)
        cancelAnimationFrame(viewportInertiaFrame.current);
    },
    [],
  );
  const task = project?.tasks.find((item) => item.taskId === taskId) ?? null,
    draft = project?.drafts.find((item) => item.taskId === taskId) ?? null;
  const view = useMemo(
    () =>
      mode === "draft" && project
        ? projectDraft(project.currentMap, draft)
        : {
            entities: project?.currentMap.entities ?? [],
            relations: project?.currentMap.relations ?? [],
          },
    [mode, project, draft],
  );
  const visibleEntities = useMemo(
    () => view.entities.filter((entity) => !hiddenTypes.has(entity.type)),
    [view.entities, hiddenTypes],
  );
  const visibleIds = useMemo(
    () => new Set(visibleEntities.map((entity) => entity.id)),
    [visibleEntities],
  );
  const visibleRelations = useMemo(
    () =>
      view.relations.filter(
        (relation) =>
          visibleIds.has(relation.sourceId) &&
          visibleIds.has(relation.targetId),
      ),
    [view.relations, visibleIds],
  );
  const positions = useMemo(
    () => forceLayout(visibleEntities, visibleRelations),
    [visibleEntities, visibleRelations],
  );
  const degrees = useMemo(() => {
    const result = new Map<string, number>();
    for (const relation of visibleRelations) {
      result.set(relation.sourceId, (result.get(relation.sourceId) ?? 0) + 1);
      result.set(relation.targetId, (result.get(relation.targetId) ?? 0) + 1);
    }
    return result;
  }, [visibleRelations]);
  const relatedIds = useMemo(() => {
    const result = new Set<string>();
    if (selectedRelation) {
      result.add(selectedRelation.sourceId);
      result.add(selectedRelation.targetId);
      return result;
    }
    if (!selected) return result;
    result.add(selected.id);
    for (const relation of visibleRelations) {
      if (relation.sourceId === selected.id) result.add(relation.targetId);
      if (relation.targetId === selected.id) result.add(relation.sourceId);
    }
    return result;
  }, [selected, selectedRelation, visibleRelations]);
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const layoutScope =
    mode === "current" ? "current" : `draft:${taskId ?? "none"}`;
  const generatedNodes = useMemo<GraphNode[]>(
    () =>
      visibleEntities.map((entity) => {
        const match =
          !normalizedQuery ||
          (
            entity.name +
            " " +
            entity.id +
            " " +
            (labels[entity.type] ?? entity.type)
          )
            .toLocaleLowerCase("ru")
            .includes(normalizedQuery);
        return {
          id: entity.id,
          type: "knowledge",
          position: manualPositions.current.get(
            `${layoutScope}:${entity.id}`,
          ) ??
            positions.get(entity.id) ?? { x: 0, y: 0 },
          data: {
            label: entity.name,
            color: colorFor(entity.type),
            shape: shapeFor(entity.type),
            size: 14 + Math.min((degrees.get(entity.id) ?? 0) * 2, 12),
            dimmed:
              !match ||
              (Boolean(selected || selectedRelation) && !relatedIds.has(entity.id)),
            related: selected || selectedRelation
              ? relatedIds.has(entity.id) && entity.id !== selected?.id
              : false,
          },
          selected: selected?.id === entity.id,
          draggable: true,
          connectable: false,
          selectable: true,
        };
      }),
    [
      visibleEntities,
      normalizedQuery,
      positions,
      degrees,
      selected,
      selectedRelation,
      relatedIds,
      layoutScope,
    ],
  );
  useEffect(() => {
    const sameScope = layoutScopeRef.current === layoutScope;
    layoutScopeRef.current = layoutScope;
    setNodes((current) => {
      const currentById = new Map(current.map((node) => [node.id, node]));
      return generatedNodes.map((node) => {
        const existing = sameScope ? currentById.get(node.id) : undefined;
        return existing
          ? {
              ...node,
              position: existing.position,
              dragging: existing.dragging,
            }
          : node;
      });
    });
  }, [generatedNodes, layoutScope, setNodes]);
  useEffect(() => {
    if (nodePhysicsFrame.current !== null) {
      cancelAnimationFrame(nodePhysicsFrame.current);
      nodePhysicsFrame.current = null;
    }
    nodeVelocities.current.clear();
    physicsActiveIds.current.clear();
    nodeSettleDeadline.current = 0;
    draggedNodeId.current = null;
    lastDrag.current = null;
  }, [layoutScope]);
  const edges = useMemo<Edge[]>(
    () =>
      visibleRelations.map((relation) => {
        const active = selectedRelation
          ? selectedRelation.id === relation.id
          : !selected || relation.sourceId === selected.id || relation.targetId === selected.id;
        const kind = relationKind(relation.type);
        return {
          id: relation.id,
          source: relation.sourceId,
          target: relation.targetId,
          type: "floating",
          selectable: true,
          selected: selectedRelation?.id === relation.id,
          interactionWidth: 16,
          style: {
            stroke: active ? "#aaa3c4" : "#55525f",
            strokeWidth: active ? 1.7 : 0.85,
            strokeDasharray: kind === "structure" ? "6 5" : kind === "dependency" ? "2 5" : undefined,
            opacity: selected || selectedRelation ? (active ? 0.95 : 0.12) : 0.72,
          },
        };
      }),
    [visibleRelations, selected, selectedRelation],
  );
  const entityTypes = useMemo(
    () =>
      Array.from(new Set(view.entities.map((entity) => entity.type))).sort(),
    [view.entities],
  );
  const selectTask = (next: Task) => {
    setTaskId(next.taskId);
    setSelected(null);
    setMode("draft");
    setQuery("");
    setHiddenTypes(new Set());
  };
  const toggleType = (type: string) =>
    setHiddenTypes((current) => {
      const next = new Set(current);
      next.has(type) ? next.delete(type) : next.add(type);
      return next;
    });
  const stopViewportInertia = () => {
    if (viewportInertiaFrame.current !== null) {
      cancelAnimationFrame(viewportInertiaFrame.current);
      viewportInertiaFrame.current = null;
    }
  };
  const onMoveStart: OnMove = (event, viewport) => {
    if (!event) return;
    stopViewportInertia();
    viewportMotion.current = {
      viewport,
      at: performance.now(),
      velocity: { x: 0, y: 0 },
    };
  };
  const onMove: OnMove = (event, viewport) => {
    if (!event) return;
    const previous = viewportMotion.current,
      now = performance.now();
    if (!previous) {
      viewportMotion.current = { viewport, at: now, velocity: { x: 0, y: 0 } };
      return;
    }
    const elapsed = Math.max(now - previous.at, 8),
      instantX = (viewport.x - previous.viewport.x) / elapsed,
      instantY = (viewport.y - previous.viewport.y) / elapsed;
    viewportMotion.current = {
      viewport,
      at: now,
      velocity: {
        x: previous.velocity.x * 0.45 + instantX * 0.55,
        y: previous.velocity.y * 0.45 + instantY * 0.55,
      },
    };
  };
  const onMoveEnd: OnMove = (event, viewport) => {
    if (!event || !flowRef.current) return;
    const motion = viewportMotion.current;
    viewportMotion.current = null;
    if (!motion || performance.now() - motion.at > 100) return;
    let velocity = { ...motion.velocity },
      current = { ...viewport },
      previousTime = performance.now();
    const glideStarted = previousTime;
    if (Math.hypot(velocity.x, velocity.y) < 0.08) return;
    const glide = (time: number) => {
      if (time - glideStarted >= 2000) {
        viewportInertiaFrame.current = null;
        return;
      }
      const elapsed = Math.min(time - previousTime, 32);
      previousTime = time;
      current = {
        ...current,
        x: current.x + velocity.x * elapsed,
        y: current.y + velocity.y * elapsed,
      };
      void flowRef.current?.setViewport(current, { duration: 0 });
      const progress = Math.min((time - glideStarted) / 2000, 1),
        damping = Math.pow(0.86 - progress * 0.16, elapsed / 16.667);
      velocity = { x: velocity.x * damping, y: velocity.y * damping };
      if (Math.hypot(velocity.x, velocity.y) > 0.012)
        viewportInertiaFrame.current = requestAnimationFrame(glide);
      else viewportInertiaFrame.current = null;
    };
    viewportInertiaFrame.current = requestAnimationFrame(glide);
  };
  const savePositions = (nextNodes: GraphNode[]) => {
    for (const node of nextNodes)
      manualPositions.current.set(`${layoutScope}:${node.id}`, node.position);
  };
  const startNodePhysics = () => {
    if (nodePhysicsFrame.current !== null) return;
    let previousTime = performance.now(),
      quietFrames = 0;
    const tick = (time: number) => {
      const settling = draggedNodeId.current === null;
      if (settling && time >= nodeSettleDeadline.current) {
        nodePhysicsFrame.current = null;
        nodeVelocities.current.clear();
        physicsActiveIds.current.clear();
        return;
      }
      const settleProgress = settling
          ? Math.min(
              Math.max(1 - (nodeSettleDeadline.current - time) / 2000, 0),
              1,
            )
          : 0,
        frameScale = Math.min(
          Math.max((time - previousTime) / 16.667, 0.45),
          2,
        );
      previousTime = time;
      let moving = !settling;
      setNodes((current) => {
        if (!current.length) return current;
        const byId = new Map(current.map((node) => [node.id, node])),
          velocities = nodeVelocities.current,
          active = physicsActiveIds.current,
          linkedPairs = new Set(
            visibleRelations.map((relation) =>
              relationPairKey(relation.sourceId, relation.targetId),
            ),
          );
        for (let i = 0; i < current.length; i++)
          for (let j = i + 1; j < current.length; j++) {
            const a = current[i],
              b = current[j],
              related = linkedPairs.has(relationPairKey(a.id, b.id)),
              collisionRadius = related
                ? RELATED_COLLISION_RADIUS
                : UNRELATED_COLLISION_RADIUS;
            let dx = a.position.x - b.position.x,
              dy = a.position.y - b.position.y;
            const distance = Math.max(Math.hypot(dx, dy), 18);
            if (
              (!active.has(a.id) && !active.has(b.id)) ||
              distance > collisionRadius
            )
              continue;
            active.add(a.id);
            active.add(b.id);
            dx /= distance;
            dy /= distance;
            const strength =
              ((collisionRadius - distance) / collisionRadius) *
              (related ? 0.34 : 0.22);
            if (a.id !== draggedNodeId.current) {
              const velocity = velocities.get(a.id) ?? { x: 0, y: 0 };
              velocity.x += dx * strength;
              velocity.y += dy * strength;
              velocities.set(a.id, velocity);
            }
            if (b.id !== draggedNodeId.current) {
              const velocity = velocities.get(b.id) ?? { x: 0, y: 0 };
              velocity.x -= dx * strength;
              velocity.y -= dy * strength;
              velocities.set(b.id, velocity);
            }
          }
        for (const relation of visibleRelations) {
          const source = byId.get(relation.sourceId),
            target = byId.get(relation.targetId);
          if (
            !source ||
            !target ||
            (!active.has(source.id) && !active.has(target.id))
          )
            continue;
          active.add(source.id);
          active.add(target.id);
          const dx = target.position.x - source.position.x,
            dy = target.position.y - source.position.y,
            distance = Math.max(Math.hypot(dx, dy), 1),
            strength = (distance - 145) * 0.0027;
          if (source.id !== draggedNodeId.current) {
            const velocity = velocities.get(source.id) ?? { x: 0, y: 0 };
            velocity.x += (dx / distance) * strength;
            velocity.y += (dy / distance) * strength;
            velocities.set(source.id, velocity);
          }
          if (target.id !== draggedNodeId.current) {
            const velocity = velocities.get(target.id) ?? { x: 0, y: 0 };
            velocity.x -= (dx / distance) * strength;
            velocity.y -= (dy / distance) * strength;
            velocities.set(target.id, velocity);
          }
        }
        const damping = Math.pow(0.82 - settleProgress * 0.24, frameScale),
          next = current.map((node) => {
            if (node.id === draggedNodeId.current || !active.has(node.id))
              return node;
            const velocity = velocities.get(node.id) ?? { x: 0, y: 0 };
            velocity.x = Math.max(-18, Math.min(18, velocity.x * damping));
            velocity.y = Math.max(-18, Math.min(18, velocity.y * damping));
            velocities.set(node.id, velocity);
            const speed = Math.hypot(velocity.x, velocity.y);
            if (speed > 0.035) moving = true;
            return speed > 0.01
              ? {
                  ...node,
                  position: {
                    x: node.position.x + velocity.x * frameScale,
                    y: node.position.y + velocity.y * frameScale,
                  },
                }
              : node;
          });
        savePositions(next);
        return next;
      });
      quietFrames = moving ? 0 : quietFrames + 1;
      if (
        draggedNodeId.current !== null ||
        (time < nodeSettleDeadline.current && quietFrames < 3)
      )
        nodePhysicsFrame.current = requestAnimationFrame(tick);
      else {
        nodePhysicsFrame.current = null;
        nodeVelocities.current.clear();
        physicsActiveIds.current.clear();
      }
    };
    nodePhysicsFrame.current = requestAnimationFrame(tick);
  };
  const onNodeDragStart: NonNullable<
    ReactFlowProps<GraphNode, Edge>["onNodeDragStart"]
  > = (_, node) => {
    draggedNodeId.current = node.id;
    physicsActiveIds.current = connectedComponentIds(node.id, visibleRelations);
    nodeSettleDeadline.current = Number.POSITIVE_INFINITY;
    nodeVelocities.current.clear();
    lastDrag.current = {
      id: node.id,
      position: node.position,
      at: performance.now(),
      velocity: { x: 0, y: 0 },
    };
    startNodePhysics();
  };
  const onNodeDrag: NonNullable<
    ReactFlowProps<GraphNode, Edge>["onNodeDrag"]
  > = (_, node) => {
    const sample = lastDrag.current;
    if (!sample || sample.id !== node.id) return;
    const now = performance.now(),
      elapsedFrames = Math.max((now - sample.at) / 16.667, 0.45),
      dx = node.position.x - sample.position.x,
      dy = node.position.y - sample.position.y,
      dragVelocity = { x: dx / elapsedFrames, y: dy / elapsedFrames },
      connected = new Set<string>();
    for (const relation of visibleRelations) {
      if (relation.sourceId === node.id) connected.add(relation.targetId);
      if (relation.targetId === node.id) connected.add(relation.sourceId);
    }
    setNodes((current) => {
      const next = current.map((other) => {
        if (other.id === node.id) return { ...other, position: node.position };
        const isConnected = connected.has(other.id),
          offsetX = other.position.x - node.position.x,
          offsetY = other.position.y - node.position.y,
          distance = Math.max(Math.hypot(offsetX, offsetY), 1),
          proximityRadius = isConnected
            ? RELATED_COLLISION_RADIUS
            : UNRELATED_DRAG_RADIUS,
          proximity = Math.max(0, 1 - distance / proximityRadius),
          linkFollow = isConnected ? 0.14 : 0,
          transfer = linkFollow + proximity * 0.08,
          impulse = {
            x:
              dx * transfer +
              (offsetX / distance) * Math.hypot(dx, dy) * proximity * 0.035,
            y:
              dy * transfer +
              (offsetY / distance) * Math.hypot(dx, dy) * proximity * 0.035,
          },
          velocity = nodeVelocities.current.get(other.id) ?? { x: 0, y: 0 };
        if (transfer || proximity) physicsActiveIds.current.add(other.id);
        nodeVelocities.current.set(other.id, {
          x: velocity.x * 0.55 + impulse.x,
          y: velocity.y * 0.55 + impulse.y,
        });
        return transfer || proximity
          ? {
              ...other,
              position: {
                x: other.position.x + impulse.x,
                y: other.position.y + impulse.y,
              },
            }
          : other;
      });
      savePositions(next);
      return next;
    });
    lastDrag.current = {
      id: node.id,
      position: node.position,
      at: now,
      velocity: dragVelocity,
    };
  };
  const onNodeDragStop: NonNullable<
    ReactFlowProps<GraphNode, Edge>["onNodeDragStop"]
  > = (_, node) => {
    const sample = lastDrag.current;
    manualPositions.current.set(`${layoutScope}:${node.id}`, node.position);
    if (sample?.id === node.id)
      nodeVelocities.current.set(node.id, {
        x: sample.velocity.x * 0.32,
        y: sample.velocity.y * 0.32,
      });
    draggedNodeId.current = null;
    nodeSettleDeadline.current = performance.now() + 2000;
    lastDrag.current = null;
    startNodePhysics();
  };
  const resetLayout = () => {
    stopViewportInertia();
    if (nodePhysicsFrame.current !== null) {
      cancelAnimationFrame(nodePhysicsFrame.current);
      nodePhysicsFrame.current = null;
    }
    nodeSettleDeadline.current = 0;
    nodeVelocities.current.clear();
    physicsActiveIds.current.clear();
    for (const key of manualPositions.current.keys())
      if (key.startsWith(layoutScope + ":"))
        manualPositions.current.delete(key);
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        position: positions.get(node.id) ?? node.position,
      })),
    );
    requestAnimationFrame(() =>
      flow?.fitView({ padding: 0.26, maxZoom: 1.15, duration: 420 }),
    );
  };
  return (
    <div className="shell">
      <header>
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="brand">
          <strong>Архитектурная карта</strong>
          <span>Architecture Knowledge Graph</span>
        </div>
        <div className="view-tabs">
          <button
            className={mode === "current" ? "active" : ""}
            onClick={() => {
              setMode("current");
              setSelected(null);
              setHiddenTypes(new Set());
            }}
          >
            Актуальная карта
          </button>
          <button
            className={mode === "draft" ? "active" : ""}
            onClick={() => {
              setMode("draft");
              setSelected(null);
              setHiddenTypes(new Set());
            }}
          >
            Драфт задачи
          </button>
        </div>
        <div className="revision">
          {mode === "current"
            ? "R" + (project?.currentMap.revision ?? "—")
            : (task?.taskId ?? "—") +
              " · база R" +
              (draft?.baseRevision ?? "—")}
          <span className="readonly">Модель read-only</span>
        </div>
      </header>
      {error && (
        <div className="error">
          {error}. Запустите <code>npm run dev</code>.
        </div>
      )}
      <main>
          <aside className="sidebar left-sidebar">
            <section>
              <div className="section-title">
                <span>Задачи</span>
                <b>{project?.tasks.length ?? 0}</b>
              </div>
              {!project?.tasks.length ? (
                <SmallEmpty text="Нет задач" />
              ) : (
                <div className="task-list">
                  {project.tasks.map((item) => (
                    <button
                      className={
                        "task-row " + (item.taskId === taskId ? "selected" : "")
                      }
                      key={item.taskId}
                      onClick={() => selectTask(item)}
                    >
                      <span className="task-status" />
                      <span>
                        <strong>{item.title}</strong>
                        <small>
                          {item.taskId} ·{" "}
                          {project.drafts.some((d) => d.taskId === item.taskId)
                            ? "есть драфт"
                            : "без драфта"}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section className="filters">
              <div className="section-title">
                <span>Группы</span>
                <b>{entityTypes.length}</b>
              </div>
              {entityTypes.map((type) => (
                <label
                  key={type}
                  className={hiddenTypes.has(type) ? "muted-type" : ""}
                >
                  <input
                    type="checkbox"
                    checked={!hiddenTypes.has(type)}
                    onChange={() => toggleType(type)}
                  />
                  <i
                    className={"type-marker shape-" + shapeFor(type)}
                    style={{ background: colorFor(type) }}
                  />
                  <span>{labels[type] ?? type}</span>
                  <small>
                    {
                      view.entities.filter((entity) => entity.type === type)
                        .length
                    }
                  </small>
                </label>
              ))}
            </section>
            <div className="sidebar-note">
              <span>◉</span>
              <p>
                Тяните узлы, чтобы удобнее разложить карту. Связанные и соседние
                узлы реагируют с затуханием; позиции живут только в этом окне.
              </p>
            </div>
          </aside>
          <section className="graph-panel">
            <div className="graph-toolbar">
              <label className="search">
                <span>⌕</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Поиск по названию или ID"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    aria-label="Очистить поиск"
                  >
                    ×
                  </button>
                )}
              </label>
              <button
                className="layout-button"
                onClick={resetLayout}
                title="Сбросить ручные позиции"
              >
                ↻ <span>Автораскладка</span>
              </button>
              <div className="graph-meta">
                <span>{visibleEntities.length} узлов</span>
                <span>{visibleRelations.length} связей</span>
              </div>
            </div>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              nodesDraggable
              nodesConnectable={false}
              edgesReconnectable={false}
              elementsSelectable
              panOnDrag
              zoomOnScroll
              zoomOnPinch
              minZoom={0.18}
              maxZoom={2.6}
              deleteKeyCode={null}
              selectionKeyCode={null}
              fitView
              fitViewOptions={{ padding: 0.26, maxZoom: 1.15 }}
              onInit={(instance) => {
                setFlow(instance);
                flowRef.current = instance;
              }}
              onMoveStart={onMoveStart}
              onMove={onMove}
              onMoveEnd={onMoveEnd}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onPaneClick={() => {
                setSelected(null);
                setSelectedRelation(null);
              }}
              onNodeClick={(_, node) => {
                setSelectedRelation(null);
                setSelected(
                  view.entities.find((entity) => entity.id === node.id) ?? null,
                );
              }}
              onEdgeClick={(_, edge) => {
                setSelected(null);
                setSelectedRelation(
                  view.relations.find((relation) => relation.id === edge.id) ?? null,
                );
              }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#393841" gap={32} size={1} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) => String((node.data as GraphNodeData).color)}
                nodeStrokeColor="#18181c"
                nodeStrokeWidth={3}
                maskColor="rgba(15,15,19,.72)"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
            {!nodes.length && (
              <div className="graph-empty">
                <Empty
                  text={
                    mode === "draft" && !draft
                      ? "У задачи нет драфта"
                      : "Нет объектов для отображения"
                  }
                  sub={
                    mode === "draft"
                      ? "Предпросмотр вычисляется из CurrentMap и операций задачи."
                      : "Опубликованная карта пока пуста."
                  }
                />
              </div>
            )}
            <div className="legend" aria-label="Легенда связей">
              <span><i className="legend-line flow" />поток данных</span>
              <span><i className="legend-line structure" />состав</span>
              <span><i className="legend-line dependency" />зависимость</span>
              <span className="layout-hint">без подписей на полотне</span>
            </div>
          </section>
          <aside className="sidebar inspector">
            <div className="section-title">
              <span>Свойства</span>
              <b>⌘</b>
            </div>
            {selected ? (
              <div className="props">
                <div className="entity-title">
                  <i
                    className={"entity-shape shape-" + shapeFor(selected.type)}
                    style={{ background: colorFor(selected.type) }}
                  />
                  <div>
                    <h2>{selected.name}</h2>
                    <span>{labels[selected.type] ?? selected.type}</span>
                  </div>
                </div>
                <dl>
                  <dt>Стабильный ID</dt>
                  <dd>
                    <code>{selected.id}</code>
                  </dd>
                  <dt>Состояние</dt>
                  <dd>
                    <Status value={selected.architectureState} />
                  </dd>
                  <dt>Уверенность</dt>
                  <dd>
                    <Status value={selected.confidence} />
                  </dd>
                  {selected.description && (
                    <>
                      <dt>Описание</dt>
                      <dd>{selected.description}</dd>
                    </>
                  )}
                  <dt>Основания</dt>
                  <dd>
                    {selected.evidenceIds.length
                      ? selected.evidenceIds.join(", ")
                      : "Не указаны"}
                  </dd>
                  {Object.keys(selected.metadata).length > 0 && (
                    <>
                      <dt>Метаданные</dt>
                      <dd className="metadata">
                        {Object.entries(selected.metadata).map(
                          ([key, value]) => (
                            <span key={key}>
                              <b>{key}</b>
                              {value}
                            </span>
                          ),
                        )}
                      </dd>
                    </>
                  )}
                </dl>
                <div className="connections">
                  <strong>Связи</strong>
                  <span>
                    {visibleRelations.filter(
                      (relation) => relation.sourceId === selected.id || relation.targetId === selected.id,
                    ).length}
                  </span>
                </div>
                <div className="relation-list">
                  {visibleRelations
                    .filter((relation) => relation.sourceId === selected.id || relation.targetId === selected.id)
                    .map((relation) => {
                      const outgoing = relation.sourceId === selected.id;
                      const otherId = outgoing ? relation.targetId : relation.sourceId;
                      const other = view.entities.find((entity) => entity.id === otherId);
                      return (
                        <button key={relation.id} onClick={() => {
                          setSelected(null);
                          setSelectedRelation(relation);
                        }}>
                          <small>{outgoing ? "→" : "←"} {relationLabels[relation.type] ?? relation.type}</small>
                          <span>{other?.name ?? otherId}</span>
                        </button>
                      );
                    })}
                </div>
                <div className="notice">
                  Свойства доступны только для просмотра. Источник изменений —
                  структурированный драфт задачи.
                </div>
              </div>
            ) : selectedRelation ? (
              <div className="props relation-props">
                <div className="relation-title">
                  <i className={"legend-line " + relationKind(selectedRelation.type)} />
                  <div>
                    <h2>{relationLabels[selectedRelation.type] ?? selectedRelation.type}</h2>
                    <span>{selectedRelation.type}</span>
                  </div>
                </div>
                <dl>
                  <dt>Стабильный ID</dt>
                  <dd><code>{selectedRelation.id}</code></dd>
                  <dt>Откуда</dt>
                  <dd>{view.entities.find((entity) => entity.id === selectedRelation.sourceId)?.name ?? selectedRelation.sourceId}</dd>
                  <dt>Куда</dt>
                  <dd>{view.entities.find((entity) => entity.id === selectedRelation.targetId)?.name ?? selectedRelation.targetId}</dd>
                  <dt>Уверенность</dt>
                  <dd><Status value={selectedRelation.confidence} /></dd>
                  {selectedRelation.label && <><dt>Описание</dt><dd>{selectedRelation.label}</dd></>}
                  <dt>Основания</dt>
                  <dd>{selectedRelation.evidenceIds.length ? selectedRelation.evidenceIds.join(", ") : "Не указаны"}</dd>
                </dl>
                <div className="notice">Подпись связи убрана с полотна и доступна здесь по выбору стрелки.</div>
              </div>
            ) : (
              <Empty
                text="Выберите объект или связь"
                sub="На полотне останется только структура; подробности появятся здесь."
              />
            )}
          </aside>
      </main>
      <footer>
        <span>{mode === "current" ? "CurrentMap" : "DraftPreview"}</span>
        <span>Панорама · инерция · масштаб · поиск · перемещение узлов</span>
        <span>Связи и модель защищены</span>
      </footer>
    </div>
  );
}

function Status({ value }: { value: string }) {
  return <span className={"status status-" + value}>{value}</span>;
}
function SmallEmpty({ text }: { text: string }) {
  return <div className="small-empty">{text}</div>;
}
function Empty({ text, sub }: { text: string; sub: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">◌</div>
      <strong>{text}</strong>
      <span>{sub}</span>
    </div>
  );
}

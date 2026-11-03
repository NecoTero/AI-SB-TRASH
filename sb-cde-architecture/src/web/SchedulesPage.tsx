import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  ProjectSchedule,
  ProjectScheduleSummary,
  ScheduleVersion,
  SourceScheduleOperation,
} from "../shared/schedule";

type ScheduleView = "works" | "grouped" | "tree";
type TreeRow = { operation: SourceScheduleOperation; depth: number };
type MonitoringSection =
  | "Shell&Core"
  | "Fit-out: служебные и технические помещения";
type WorkGroupingAttribute = "building" | "floor";
type MonitoringWorkEntry = {
  operation: SourceScheduleOperation;
  section: MonitoringSection;
  hierarchyPath: string[];
  building: string | null;
  floor: string | null;
};
type WorkGroupNode = {
  id: string;
  attribute: "kfo" | WorkGroupingAttribute;
  label: string;
  operationCount: number;
  children: WorkGroupNode[];
  entries: MonitoringWorkEntry[];
};
type WorkTableRow =
  | { kind: "operation"; operation: SourceScheduleOperation; depth: number }
  | { kind: "group"; group: WorkGroupNode; depth: number };

const keyOf = (operation: SourceScheduleOperation) =>
  String(operation.uid ?? operation.id);

function parentKeyOf(operation: SourceScheduleOperation): string | null {
  const rawParentKey = operation.parentUid ?? operation.parentId;
  if (rawParentKey === null || rawParentKey === undefined) return null;
  const parentKey = String(rawParentKey).trim();
  return parentKey === "" ? null : parentKey;
}
function normalizedName(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru");
}

function allowedSection(names: string[]): MonitoringSection | null {
  const normalized = names.map(normalizedName);
  const smrIndex = normalized.findIndex((name) => name === "смр");
  if (smrIndex < 0) return null;
  const descendants = normalized.slice(smrIndex + 1);
  if (descendants.some((name) => name.includes("работы раздела shell&core")))
    return "Shell&Core";
  if (
    descendants.some(
      (name) =>
        name.includes("работы раздела fit-out") &&
        name.includes("служебные и технические помещения"),
    )
  )
    return "Fit-out: служебные и технические помещения";
  return null;
}

function lastMatchingName(names: string[], predicate: (name: string) => boolean) {
  for (let index = names.length - 1; index >= 0; index -= 1) {
    if (predicate(names[index]))
      return names[index].replace(/\s+/g, " ").trim();
  }
  return null;
}

export function monitoringWorkEntries(
  operations: SourceScheduleOperation[],
): MonitoringWorkEntry[] {
  const byKey = new Map(
    operations.map((operation) => [keyOf(operation), operation]),
  );
  const pathCache = new Map<string, string[]>();
  const operationPath = (operation: SourceScheduleOperation): string[] => {
    const key = keyOf(operation);
    const cached = pathCache.get(key);
    if (cached) return cached;
    const path: string[] = [];
    const seen = new Set<string>([key]);
    let current: SourceScheduleOperation | undefined = operation;
    while (current) {
      path.unshift(current.name);
      const parent = parentKeyOf(current);
      if (!parent || seen.has(parent)) break;
      seen.add(parent);
      current = byKey.get(parent);
    }
    pathCache.set(key, path);
    return path;
  };

  return operations.flatMap((operation) => {
    if (operation.operationType !== "activity") return [];
    const path = operationPath(operation);
    const section = allowedSection(path);
    if (!section) return [];
    const contextNames = path.slice(0, -1);
    return [{
      operation,
      section,
      hierarchyPath: path,
      building: lastMatchingName(
        contextNames,
        (name) => /^\s*корпус(?:\s|$)/i.test(name),
      ),
      floor: lastMatchingName(
        contextNames,
        (name) => /этаж(?:а|и)?|подземная часть/i.test(name),
      ),
    }];
  });
}

function userWorks(operations: SourceScheduleOperation[]) {
  return monitoringWorkEntries(operations).map((entry) => entry.operation);
}

function matchesMonitoringWork(entry: MonitoringWorkEntry, query: string) {
  const normalized = query.trim().toLocaleLowerCase("ru");
  if (!normalized) return true;
  const operation = entry.operation;
  return [
    operation.name,
    operation.id,
    operation.uid,
    operation.sourceId,
    operation.spiderCode,
    operation.wbsCode,
    operation.kfoCode,
    operation.kfoName,
    operation.cbsCode,
    operation.sourceStatus,
    entry.section,
    entry.building,
    entry.floor,
    entry.hierarchyPath.join(" › "),
  ].some((value) => value?.toLocaleLowerCase("ru").includes(normalized));
}

function groupValue(
  entry: MonitoringWorkEntry,
  attribute: WorkGroupNode["attribute"],
) {
  return attribute === "kfo" ? entry.operation.kfoCode : entry[attribute];
}

function groupLabel(
  entry: MonitoringWorkEntry,
  attribute: WorkGroupNode["attribute"],
) {
  if (attribute === "kfo") {
    if (!entry.operation.kfoCode) return "Без кода КФО";
    return entry.operation.kfoName
      ? `${entry.operation.kfoCode} — ${entry.operation.kfoName}`
      : entry.operation.kfoCode;
  }
  if (entry[attribute]) return entry[attribute];
  return attribute === "building" ? "Корпус не указан" : "Этаж не указан";
}

export function buildWorkGroupTree(
  entries: MonitoringWorkEntry[],
  optionalAttributes: WorkGroupingAttribute[],
): WorkGroupNode[] {
  const attributes: WorkGroupNode["attribute"][] = [
    "kfo",
    ...optionalAttributes,
  ];
  const buildLevel = (
    levelEntries: MonitoringWorkEntry[],
    level: number,
    parentId: string,
  ): WorkGroupNode[] => {
    const attribute = attributes[level];
    const buckets = new Map<string, MonitoringWorkEntry[]>();
    for (const entry of levelEntries) {
      const value = groupValue(entry, attribute);
      const key = value?.trim() || "__missing__";
      const bucket = buckets.get(key) ?? [];
      bucket.push(entry);
      buckets.set(key, bucket);
    }
    return [...buckets.entries()]
      .map(([value, bucket]) => {
        const id = `${parentId}/${attribute}:${encodeURIComponent(value)}`;
        const children =
          level + 1 < attributes.length
            ? buildLevel(bucket, level + 1, id)
            : [];
        return {
          id,
          attribute,
          label: groupLabel(bucket[0], attribute) ?? "Не указано",
          operationCount: bucket.length,
          children,
          entries: children.length
            ? []
            : [...bucket].sort(
                (left, right) =>
                  left.operation.sourceOrder - right.operation.sourceOrder,
              ),
        };
      })
      .sort((left, right) => {
        const leftMissing = left.id.includes("__missing__");
        const rightMissing = right.id.includes("__missing__");
        if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
        return left.label.localeCompare(right.label, "ru", { numeric: true });
      });
  };
  return entries.length ? buildLevel(entries, 0, "works") : [];
}

function hierarchyPath(
  operation: SourceScheduleOperation,
  operations: SourceScheduleOperation[],
) {
  const byKey = new Map(operations.map((item) => [keyOf(item), item]));
  const names: string[] = [];
  const seen = new Set<string>([keyOf(operation)]);
  let parentKey = parentKeyOf(operation);
  while (parentKey && byKey.has(parentKey) && !seen.has(parentKey)) {
    seen.add(parentKey);
    const parent = byKey.get(parentKey);
    if (!parent) break;
    names.unshift(parent.name);
    parentKey = parentKeyOf(parent);
  }
  return names.join(" › ");
}

export function initiallyCollapsed(operations: SourceScheduleOperation[]) {
  const byKey = new Set(operations.map(keyOf));
  const childKeys = new Set<string>();
  const parentKeys = new Set<string>();
  for (const operation of operations) {
    const parentKey = parentKeyOf(operation);
    if (parentKey && byKey.has(parentKey) && parentKey !== keyOf(operation)) {
      parentKeys.add(parentKey);
      childKeys.add(keyOf(operation));
    }
  }
  const rootKeys = new Set([...byKey].filter((key) => !childKeys.has(key)));
  return new Set([...parentKeys].filter((key) => !rootKeys.has(key)));
}

const kindLabels = {
  baseline: "Базовый",
  operational: "Операционный",
  unclassified: "Не классифицирован",
} as const;

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleDateString("ru-RU");
}

export function buildTreeRows(
  operations: SourceScheduleOperation[],
  collapsed: Set<string>,
  query: string,
): TreeRow[] {
  const byKey = new Map(operations.map((operation) => [keyOf(operation), operation]));
  const children = new Map<string, SourceScheduleOperation[]>();
  const roots: SourceScheduleOperation[] = [];
  for (const operation of operations) {
    const parentKey = parentKeyOf(operation);
    if (parentKey && byKey.has(parentKey) && parentKey !== keyOf(operation)) {
      const list = children.get(parentKey) ?? [];
      list.push(operation);
      children.set(parentKey, list);
    } else roots.push(operation);
  }
  for (const list of children.values()) list.sort((a, b) => a.sourceOrder - b.sourceOrder);
  roots.sort((a, b) => a.sourceOrder - b.sourceOrder);
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const matches = new Set((normalizedQuery ? operations.filter((operation) => [
    operation.name, operation.id, operation.uid, operation.sourceId,
    operation.spiderCode, operation.wbsCode, operation.kfoCode,
    operation.cbsCode, operation.sourceStatus,
  ].some((value) => value?.toLocaleLowerCase("ru").includes(normalizedQuery))) : operations).map(keyOf));
  const visible = new Set(matches);
  const addAncestors = (key: string) => {
    const operation = byKey.get(key);
    if (!operation) return;
    const parentKey = parentKeyOf(operation);
    if (parentKey && byKey.has(parentKey) && !visible.has(parentKey)) {
      visible.add(parentKey);
      addAncestors(parentKey);
    }
  };
  for (const key of matches) addAncestors(key);
  const rows: TreeRow[] = [];
  const visited = new Set<string>();
  const visit = (operation: SourceScheduleOperation, depth: number) => {
    const key = keyOf(operation);
    if (visited.has(key)) return;
    visited.add(key);
    if (visible.has(key)) rows.push({ operation, depth });
    const hasMatchingDescendant = Boolean(normalizedQuery) &&
      (children.get(key) ?? []).some((child) => visible.has(keyOf(child)));
    if (!collapsed.has(key) || hasMatchingDescendant)
      for (const child of children.get(key) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

export function buildGroupedWorkRows(
  groups: WorkGroupNode[],
  collapsed: Set<string>,
  revealAll: boolean,
): WorkTableRow[] {
  const rows: WorkTableRow[] = [];
  const visit = (group: WorkGroupNode, depth: number) => {
    rows.push({ kind: "group", group, depth });
    if (!revealAll && collapsed.has(group.id)) return;
    for (const child of group.children) visit(child, depth + 1);
    for (const entry of group.entries)
      rows.push({
        kind: "operation",
        operation: entry.operation,
        depth: depth + 1,
      });
  };
  for (const group of groups) visit(group, 0);
  return rows;
}

function latestVersion(schedule: ProjectSchedule) {
  return schedule.versions.at(-1) ?? null;
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<ProjectScheduleSummary[]>([]);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(
    null,
  );
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null,
  );
  const [schedule, setSchedule] = useState<ProjectSchedule | null>(null);
  const [selectedOperation, setSelectedOperation] =
    useState<SourceScheduleOperation | null>(null);
  const [view, setView] = useState<ScheduleView>("works");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapsedWorkGroups, setCollapsedWorkGroups] = useState<Set<string>>(
    new Set(),
  );
  const [workGrouping, setWorkGrouping] = useState<WorkGroupingAttribute[]>([
    "building",
    "floor",
  ]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createFileInput = useRef<HTMLInputElement>(null);
  const versionFileInput = useRef<HTMLInputElement>(null);

  const loadSchedules = async (preferredId?: string) => {
    const response = await fetch("/api/schedules");
    if (!response.ok) throw new Error("Не удалось получить каталог графиков");
    const items = (await response.json()) as ProjectScheduleSummary[];
    setSchedules(items);
    setSelectedScheduleId(
      preferredId ?? selectedScheduleId ?? items[0]?.id ?? null,
    );
  };

  useEffect(() => {
    loadSchedules().catch((reason: Error) => setError(reason.message));
  }, []);

  const applySchedule = (
    value: ProjectSchedule,
    preferredVersionId?: string,
  ) => {
    setSchedule(value);
    const version =
      value.versions.find((item) => item.id === preferredVersionId) ??
      latestVersion(value);
    setSelectedVersionId(version?.id ?? null);
    setSelectedOperation(userWorks(version?.sourceOperations ?? [])[0] ?? version?.sourceOperations[0] ?? null);
    setCollapsed(initiallyCollapsed(version?.sourceOperations ?? []));
    const initialGroups = buildWorkGroupTree(
      monitoringWorkEntries(version?.sourceOperations ?? []),
      workGrouping,
    );
    setCollapsedWorkGroups(new Set(initialGroups.map((group) => group.id)));
  };

  useEffect(() => {
    if (!selectedScheduleId) {
      setSchedule(null);
      setSelectedVersionId(null);
      setSelectedOperation(null);
      return;
    }
    fetch(`/api/schedules/${encodeURIComponent(selectedScheduleId)}`)
      .then((response) => {
        if (!response.ok) throw new Error("Не удалось открыть график");
        return response.json();
      })
      .then((value: ProjectSchedule) => applySchedule(value))
      .catch((reason: Error) => setError(reason.message));
  }, [selectedScheduleId]);

  const version =
    schedule?.versions.find((item) => item.id === selectedVersionId) ?? null;

  const workEntries = useMemo(
    () => monitoringWorkEntries(version?.sourceOperations ?? []),
    [version],
  );
  const workOperations = useMemo(
    () => workEntries.map((entry) => entry.operation),
    [workEntries],
  );

  const milestoneCount = useMemo(
    () => (version?.sourceOperations ?? []).filter((operation) => operation.operationType === "milestone").length,
    [version],
  );

  const filteredWorks = useMemo(() => {
    if (!version) return [];
    const normalized = query.trim().toLocaleLowerCase("ru");
    if (!normalized) return workOperations;
    return workEntries
      .filter((entry) => matchesMonitoringWork(entry, normalized))
      .map((entry) => entry.operation);
  }, [version, workOperations, workEntries, query]);

  const filteredWorkEntries = useMemo(
    () => workEntries.filter((entry) => matchesMonitoringWork(entry, query)),
    [workEntries, query],
  );
  const workGroups = useMemo(
    () => buildWorkGroupTree(filteredWorkEntries, workGrouping),
    [filteredWorkEntries, workGrouping],
  );
  const groupedRows = useMemo(
    () =>
      buildGroupedWorkRows(
        workGroups,
        collapsedWorkGroups,
        Boolean(query.trim()),
      ),
    [workGroups, collapsedWorkGroups, query],
  );

  const treeRows = useMemo(
    () => buildTreeRows(version?.sourceOperations ?? [], collapsed, query),
    [version, collapsed, query],
  );
  const selectedHierarchyPath = useMemo(
    () => selectedOperation
      ? hierarchyPath(selectedOperation, version?.sourceOperations ?? [])
      : "",
    [selectedOperation, version],
  );

  const parentIds = useMemo(() => {
    const result = new Set<string>();
    for (const operation of version?.sourceOperations ?? []) {
      const parentKey = parentKeyOf(operation);
      if (parentKey) result.add(parentKey);
    }
    return result;
  }, [version]);
  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!createFileInput.current?.files?.[0]) {
      setError("Выберите файл .xml");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/schedules", {
        method: "POST",
        body: new FormData(form),
      });
      const body = (await response.json()) as
        | ProjectSchedule
        | { error?: string };
      if (!response.ok)
        throw new Error(
          "error" in body && body.error
            ? body.error
            : "Не удалось создать график",
        );
      const created = body as ProjectSchedule;
      applySchedule(created);
      setMessage(
        `Создан ГВР «${created.name}» с базовой версией Б1.`,
      );
      form.reset();
      await loadSchedules(created.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ошибка импорта");
    } finally {
      setBusy(false);
    }
  };

  const deleteCurrentSchedule = async () => {
    if (!schedule) return;
    const confirmed = window.confirm(
      `Удалить ГВР «${schedule.name}» со всеми версиями и исходными XML? Это действие нельзя отменить.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/schedules/${encodeURIComponent(schedule.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Не удалось удалить график");
      }
      const catalogResponse = await fetch("/api/schedules");
      if (!catalogResponse.ok) throw new Error("Не удалось обновить каталог графиков");
      const items = (await catalogResponse.json()) as ProjectScheduleSummary[];
      const deletedName = schedule.name;
      setSchedules(items);
      setSchedule(null);
      setSelectedScheduleId(items[0]?.id ?? null);
      setSelectedVersionId(null);
      setSelectedOperation(userWorks(version?.sourceOperations ?? [])[0] ?? version?.sourceOperations[0] ?? null);
      setCollapsed(new Set());
      setCollapsedWorkGroups(new Set());
      setMessage(`ГВР «${deletedName}» удалён.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ошибка удаления графика");
    } finally {
      setBusy(false);
    }
  };
  const addVersion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!schedule || !versionFileInput.current?.files?.[0]) {
      setError("Выберите график и файл .xml");
      return;
    }
    const form = event.currentTarget;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/schedules/${encodeURIComponent(schedule.id)}/versions`,
        { method: "POST", body: new FormData(form) },
      );
      const body = (await response.json()) as
        | ProjectSchedule
        | { error?: string };
      if (!response.ok)
        throw new Error(
          "error" in body && body.error
            ? body.error
            : "Не удалось добавить версию",
        );
      const updated = body as ProjectSchedule;
      const added = latestVersion(updated);
      applySchedule(updated, added?.id);
      setMessage(`Добавлена неизменяемая версия ${added?.label ?? ""}.`);
      form.reset();
      await loadSchedules(updated.id);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Ошибка добавления версии",
      );
    } finally {
      setBusy(false);
    }
  };

  const importInbox = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/schedules/import-inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json()) as {
        imported: ProjectScheduleSummary[];
        skipped: string[];
        errors: string[];
      };
      if (!response.ok) throw new Error("Не удалось прочитать папку импорта");
      await loadSchedules(body.imported[0]?.id);
      const parts = [
        `импортировано без классификации: ${body.imported.length}`,
        `пропущено: ${body.skipped.length}`,
      ];
      if (body.errors.length) parts.push(`ошибки: ${body.errors.join("; ")}`);
      setMessage(parts.join(", "));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось прочитать папку импорта",
      );
    } finally {
      setBusy(false);
    }
  };

  const selectVersion = (id: string) => {
    setSelectedVersionId(id);
    const selected = schedule?.versions.find((item) => item.id === id);
    setSelectedOperation(userWorks(selected?.sourceOperations ?? [])[0] ?? selected?.sourceOperations[0] ?? null);
    setCollapsed(initiallyCollapsed(selected?.sourceOperations ?? []));
    const initialGroups = buildWorkGroupTree(
      monitoringWorkEntries(selected?.sourceOperations ?? []),
      workGrouping,
    );
    setCollapsedWorkGroups(new Set(initialGroups.map((group) => group.id)));
  };

  const toggleCollapsed = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const expandAll = () => setCollapsed(new Set());

  const resetTree = () => setCollapsed(initiallyCollapsed(version?.sourceOperations ?? []));

  const collapseAll = () =>
    setCollapsed(initiallyCollapsed(version?.sourceOperations ?? []));

  const toggleWorkGroup = (id: string) =>
    setCollapsedWorkGroups((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleGroupingAttribute = (attribute: WorkGroupingAttribute) => {
    setWorkGrouping((current) => {
      const next = current.includes(attribute)
        ? current.filter((item) => item !== attribute)
        : [...current, attribute].sort(
            (left, right) =>
              ["building", "floor"].indexOf(left) -
              ["building", "floor"].indexOf(right),
          );
      const nextGroups = buildWorkGroupTree(filteredWorkEntries, next);
      setCollapsedWorkGroups(new Set(nextGroups.map((group) => group.id)));
      return next;
    });
  };

  const rows: WorkTableRow[] =
    view === "tree"
      ? treeRows.map(({ operation, depth }) => ({
          kind: "operation",
          operation,
          depth,
        }))
      : view === "grouped"
        ? groupedRows
        : filteredWorks.map((operation) => ({
            kind: "operation",
            operation,
            depth: 0,
          }));
  const baseline = version?.basedOnBaselineVersionId
    ? schedule?.versions.find(
        (item) => item.id === version.basedOnBaselineVersionId,
      )
    : null;

  return (
    <main className="schedule-workspace">
      <aside className="schedule-catalog">
        <div className="section-title">
          <span>Графики ГВР</span>
          <b>{schedules.length}</b>
        </div>
        <form className="schedule-upload" onSubmit={upload}>
          <strong>Создать ГВР</strong>
          <small>Сейчас доступен один тип графика — ГВР. Первый файл фиксируется как базовая версия Б1.</small>
          <input name="name" type="text" placeholder="Название ГВР" />
          <label className="file-picker">
            <input
              ref={createFileInput}
              name="file"
              type="file"
              accept=".xml,application/xml,text/xml"
            />
            <span>Выбрать XML</span>
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Чтение…" : "Создать Б1"}
          </button>
        </form>
        <div className="inbox-import">
          <button onClick={importInbox} disabled={busy}>
            Импортировать из папки
          </button>
          <code>как график ГВР</code>
        </div>
        {message && <div className="schedule-message">{message}</div>}
        {error && <div className="schedule-error">{error}</div>}
        <div className="schedule-list">
          {schedules.map((item) => (
            <button
              key={item.id}
              className={item.id === selectedScheduleId ? "selected" : ""}
              onClick={() => setSelectedScheduleId(item.id)}
            >
              <strong>{item.name}</strong>
              <span>
                {item.versionCount} верс. · {item.latestVersionLabel} ·{" "}
                {kindLabels[item.latestVersionKind]}
              </span>
              <small>
                {item.sourceOperationCount} задач XML
                {item.projectRevision ? ` · XML rev. ${item.projectRevision}` : ""}
                {item.validationWarningCount
                  ? ` · предупреждений: ${item.validationWarningCount}`
                  : ""}
              </small>
            </button>
          ))}
          {!schedules.length && (
            <div className="small-empty">Создайте первый ГВР.</div>
          )}
        </div>
        {schedule && (
          <>
          <form className="schedule-upload version-upload" onSubmit={addVersion}>
            <strong>Добавить версию</strong>
            <select name="kind" defaultValue="operational">
              <option value="operational">Операционная</option>
              <option value="baseline">Новая базовая</option>
            </select>
            <label className="file-picker">
              <input
                ref={versionFileInput}
                name="file"
                type="file"
                accept=".xml,application/xml,text/xml"
              />
              <span>Выбрать XML</span>
            </label>
            <button type="submit" disabled={busy}>
              Добавить снимок
            </button>
          </form>
          <button
            type="button"
            className="schedule-delete"
            onClick={deleteCurrentSchedule}
            disabled={busy}
          >
            Удалить этот ГВР
          </button>
          </>
        )}
      </aside>

      <section className="schedule-content">
        <div className="schedule-toolbar">
          <label className="schedule-search">
            <span>⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                view === "tree"
                  ? "Поиск по исходному XML-дереву"
                  : "Поиск по работам: название, путь, корпус, этаж, КФО…"
              }
            />
          </label>
          <div className="schedule-view-toggle">
            <button
              className={view === "works" ? "active" : ""}
              onClick={() => setView("works")}
            >
              Работы
            </button>
            <button
              className={view === "grouped" ? "active" : ""}
              onClick={() => setView("grouped")}
            >
              Группы
            </button>
            <button
              className={view === "tree" ? "active" : ""}
              onClick={() => setView("tree")}
            >
              Дерево источника
            </button>
          </div>
          {view === "tree" && version && (
            <div className="tree-bulk-actions" aria-label="Управление уровнями дерева">
              <button type="button" onClick={resetTree} title="Корень и первый уровень">
                Исходный вид
              </button>
              <button type="button" onClick={expandAll} title="Развернуть все ветви">
                Развернуть всё
              </button>
              <button type="button" onClick={collapseAll} title="Свернуть все ветви">
                Свернуть всё
              </button>
            </div>
          )}
          {view === "grouped" && version && (
            <div className="work-grouping-controls" aria-label="Группировка работ">
              <span>КФО</span>
              <label>
                <input
                  type="checkbox"
                  checked={workGrouping.includes("building")}
                  onChange={() => toggleGroupingAttribute("building")}
                />
                Корпус
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={workGrouping.includes("floor")}
                  onChange={() => toggleGroupingAttribute("floor")}
                />
                Этаж
              </label>
              <button
                type="button"
                onClick={() => setCollapsedWorkGroups(new Set())}
              >
                Развернуть
              </button>
              <button
                type="button"
                onClick={() =>
                  setCollapsedWorkGroups(
                    new Set(workGroups.map((group) => group.id)),
                  )
                }
              >
                Свернуть
              </button>
            </div>
          )}
          {version && (
            <span className="schedule-count">
              {view === "tree"
                ? `${treeRows.length} из ${version.sourceOperations.length} задач XML`
                : query.trim()
                  ? `${filteredWorks.length} работ найдено`
                  : view === "grouped"
                    ? `${workOperations.length} работ · ${workGroups.length} групп КФО`
                    : `${workOperations.length} работ`}
            </span>
          )}
        </div>
        {schedule && version ? (
          <>
            <div className="schedule-source">
              <div>
                <strong>{schedule.name}</strong>
                <span>{version.originalFileName}</span>
              </div>
              <label className="version-picker">
                <span>Версия</span>
                <select
                  value={version.id}
                  onChange={(event) => selectVersion(event.target.value)}
                >
                  {schedule.versions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} · {kindLabels[item.kind]}
                    </option>
                  ))}
                </select>
              </label>
              <span>
                {version.label} · {kindLabels[version.kind]}
                {baseline ? ` · базис ${baseline.label}` : ""}
                {version.validationReport.projectRevision
                  ? ` · XML rev. ${version.validationReport.projectRevision}`
                  : ""}
              </span>
              <a
                className="schedule-export"
                href={`/api/schedules/${encodeURIComponent(schedule.id)}/versions/${encodeURIComponent(version.id)}/source.xml`}
                download={version.originalFileName}
              >
                Экспорт исходного XML
              </a>
            </div>
            <div className="schedule-domain-note">
              <div>
                <strong>Показатели</strong>
                <span>
                  Start / Finish — даты начала и окончания из источника; их
                  бизнес-смысл пока не сопоставлен. ActualStart / ActualFinish
                  — фактические поля источника. Бизнес-прогноз не сопоставлен.
                </span>
              </div>
              <div>
                <strong>Экспериментальная выборка СМР</strong>
                <span>
                  Показаны только операции Shell&amp;Core и Fit-out
                  служебных/технических помещений. Группировка КФО → корпус →
                  этаж вычисляется для просмотра и не меняет исходный XML.
                </span>
              </div>
            </div>
            <div className="schedule-validation">
              <span>
                <strong>{version.validationReport.taskCountExported}</strong>
                задач XML
              </span>
              <span>
                <strong>{workOperations.length}</strong>
                работ в выборке СМР
              </span>
              <span>
                <strong>{version.validationReport.summaryTasks}</strong>
                суммарных
              </span>
              <span>
                <strong>{milestoneCount}</strong>
                вех (не в работах)
              </span>
              <span>
                <strong>{version.validationReport.withKfoCode}</strong>
                с КФО
              </span>
              <span>
                <strong>{version.validationReport.predecessorLinks}</strong>
                зависимостей
              </span>
              <span>
                <strong>{version.validationReport.errors.length}</strong>
                ошибок
              </span>
            </div>
            {version.warnings.length > 0 && (
              <details className="import-warnings">
                <summary>
                  Предупреждения импорта: {version.warnings.length}
                </summary>
                <ul>
                  {version.warnings.slice(0, 30).map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="schedule-table-wrap">
              <table className="schedule-table">
                <thead>
                  <tr>
                    <th>{view === "tree" ? "Задача XML / группа" : "Работа"}</th>
                    <th>UID / ID</th>
                    <th>Spider / WBS</th>
                    <th>Коды проекта / CBS / КФО</th>
                    <th>Начало из источника</th>
                    <th>Окончание из источника</th>
                    <th>Факт начало / конец</th>
                    <th>План / факт объём</th>
                    <th>Выполнение</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) =>
                    row.kind === "group" ? (
                      <tr
                        key={row.group.id}
                        className="work-group-row"
                        onClick={() => toggleWorkGroup(row.group.id)}
                      >
                        <td colSpan={9}>
                          <div
                            className="work-group-name"
                            style={{ paddingLeft: row.depth * 18 }}
                          >
                            <button
                              className="tree-toggle"
                              aria-label={
                                collapsedWorkGroups.has(row.group.id)
                                  ? "Развернуть группу"
                                  : "Свернуть группу"
                              }
                            >
                              {collapsedWorkGroups.has(row.group.id) ? "▸" : "▾"}
                            </button>
                            <strong>{row.group.label}</strong>
                            <span>{row.group.operationCount} опер.</span>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr
                        key={row.operation.id}
                        className={
                          selectedOperation?.id === row.operation.id
                            ? "selected"
                            : ""
                        }
                        onClick={() => setSelectedOperation(row.operation)}
                        onDoubleClick={() => {
                          const key = row.operation.uid ?? row.operation.id;
                          if (view === "tree" && parentIds.has(key))
                            toggleCollapsed(key);
                        }}
                      >
                        <td>
                          <div
                            className="activity-name"
                            style={{
                              paddingLeft:
                                view === "tree" || view === "grouped"
                                  ? row.depth * 18
                                  : 0,
                            }}
                          >
                            {view === "tree" &&
                            parentIds.has(
                              row.operation.uid ?? row.operation.id,
                            ) ? (
                              <button
                                className="tree-toggle"
                                aria-label={
                                  collapsed.has(
                                    row.operation.uid ?? row.operation.id,
                                  )
                                    ? "Развернуть ветвь"
                                    : "Свернуть ветвь"
                                }
                                title="Развернуть или свернуть ветвь"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleCollapsed(
                                    row.operation.uid ?? row.operation.id,
                                  );
                                }}
                                onDoubleClick={(event) =>
                                  event.stopPropagation()
                                }
                              >
                                {collapsed.has(
                                  row.operation.uid ?? row.operation.id,
                                )
                                  ? "▸"
                                  : "▾"}
                              </button>
                            ) : view === "tree" ? (
                              <i />
                            ) : null}
                            <span>
                              {row.operation.name}
                              <small>{row.operation.sourceLocator}</small>
                            </span>
                          </div>
                        </td>
                        <td>
                          <code>
                            {row.operation.uid ?? "—"} /{" "}
                            {row.operation.sourceId ?? "—"}
                          </code>
                        </td>
                        <td>
                          <code>{row.operation.spiderCode ?? "—"}</code>
                          <small className="table-secondary">
                            {row.operation.wbsCode ?? "WBS не указан"}
                          </small>
                        </td>
                        <td>
                          <span>{row.operation.projectCode ?? "—"}</span>
                          <small className="table-secondary">
                            CBS: {row.operation.cbsCode ?? "—"} · КФО:{" "}
                            {row.operation.kfoCode ?? "—"}
                          </small>
                        </td>
                        <td>{formatDate(row.operation.sourceStart)}</td>
                        <td>{formatDate(row.operation.sourceFinish)}</td>
                        <td>
                          {formatDate(row.operation.actualStart)} /{" "}
                          {formatDate(row.operation.actualFinish)}
                        </td>
                        <td>
                          {row.operation.volumePlan ?? "—"} /{" "}
                          {row.operation.volumeFact ?? "—"}
                        </td>
                        <td>
                          {row.operation.percentComplete === null
                            ? "—"
                            : String(
                                Math.round(row.operation.percentComplete),
                              ) + "%"}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
              {!rows.length && (
                <div className="small-empty">
                  {view === "tree" ? "Задачи XML по запросу не найдены." : "Работы по запросу не найдены."}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="empty">
            <div className="empty-icon">▦</div>
            <strong>ГВР не выбран</strong>
            <span>Создайте ГВР из базового XML или выберите существующий.</span>
          </div>
        )}
      </section>

      <aside className="schedule-inspector">
        <div className="section-title">
          <span>Исходная операция</span>
          <b>{selectedOperation ? "1" : "—"}</b>
        </div>
        {selectedOperation ? (
          <div className="work-card">
            <h2>{selectedOperation.name}</h2>
            <span className="work-kind">
              {selectedOperation.operationType}
            </span>
            <dl>
              <dt>Локальный ID</dt>
              <dd><code>{selectedOperation.id}</code></dd>
              <dt>Исходный ID</dt>
              <dd>{selectedOperation.sourceId ?? "Не указан"}</dd>
              <dt>UID</dt>
              <dd>{selectedOperation.uid ?? "Не указан"}</dd>
              <dt>Spider_Code</dt>
              <dd>{selectedOperation.spiderCode ?? "Не указан"}</dd>
              <dt>WBS</dt>
              <dd>{selectedOperation.wbsCode ?? "Не указан"}</dd>
              <dt>OutlineNumber</dt>
              <dd>{selectedOperation.outlineNumber ?? "Не указан"}</dd>
              <dt>Родитель</dt>
              <dd>
                {selectedOperation.parentUid
                  ? `UID ${selectedOperation.parentUid}`
                  : "Нет"}
              </dd>
              <dt>Путь в дереве</dt>
              <dd>{selectedHierarchyPath || "Корневой узел"}</dd>
              <dt>Код КФО</dt>
              <dd>{selectedOperation.kfoCode ?? "Не указан"}</dd>
              <dt>КФО</dt>
              <dd>{selectedOperation.kfoName ?? "Не указан"}</dd>
              <dt>Код CBS</dt>
              <dd>{selectedOperation.cbsCode ?? "Не указан"}</dd>
              <dt>Начало из источника</dt>
              <dd>{formatDate(selectedOperation.sourceStart)}</dd>
              <dt>Окончание из источника</dt>
              <dd>{formatDate(selectedOperation.sourceFinish)}</dd>
              <dt>Фактическое начало</dt>
              <dd>{formatDate(selectedOperation.actualStart)}</dd>
              <dt>Фактическое окончание</dt>
              <dd>{formatDate(selectedOperation.actualFinish)}</dd>
              <dt>Выполнение</dt>
              <dd>
                {selectedOperation.percentComplete === null
                  ? "Не указано"
                  : `${selectedOperation.percentComplete}%`}
              </dd>
              <dt>Статус источника</dt>
              <dd>{selectedOperation.sourceStatus ?? "Не указан"}</dd>
              <dt>Плановый объём</dt>
              <dd>{selectedOperation.volumePlan ?? "Не указан"}</dd>
              <dt>Фактический объём</dt>
              <dd>{selectedOperation.volumeFact ?? "Не указан"}</dd>
              <dt>Предшественники</dt>
              <dd>
                {selectedOperation.predecessorLinks.length
                  ? selectedOperation.predecessorLinks
                      .map((link) => link.predecessorUid)
                      .join(", ")
                  : "Нет"}
              </dd>
            </dl>
            <details className="raw-fields">
              <summary>Все поля исходной операции</summary>
              <dl>
                {Object.entries(selectedOperation.fields).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value === null || value === "" ? "—" : String(value)}</dd>
                  </div>
                ))}
              </dl>
            </details>
            {Object.keys(selectedOperation.extendedFields).length > 0 && (
              <details className="raw-fields">
                <summary>Пользовательские поля по FieldID</summary>
                <dl>
                  {Object.entries(selectedOperation.extendedFields).map(
                    ([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>
                          {value === null || value === ""
                            ? "—"
                            : String(value)}
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
              </details>
            )}
          </div>
        ) : (
          <div className="empty">
            <div className="empty-icon">□</div>
            <strong>Выберите исходную операцию</strong>
            <span>Здесь появятся нормализованные и исходные поля XML.</span>
          </div>
        )}
      </aside>
    </main>
  );
}


import type {
  IfcElementBinding, ModelWorkGroup, ModelWorksResponse, ModelWorkSource,
  MonitoringSnapshot, MonitoringStatusPatch, MonitoringStatusValue,
} from "../shared/monitoring.js";
import { BIM_MODELS, type BimModelId } from "../shared/models.js";
import { activeIdentifierKeys, type SystemIdentifierKey } from "../shared/identifiers.js";
import type { ScheduleSnapshot, SourceOperation } from "../shared/schedule.js";
import {
  calculateOperationStatus,
  type CalculatedOperationStatus,
  type ScheduleDeviation,
} from "../shared/status.js";
import { readIfcElements } from "./ifc-model.js";
import { createBaselineMatcher } from "./operation-identity.js";
import { getSchedule, getSnapshot } from "./repository.js";
import { readIdentifierSettings } from "./identifier-settings.js";

const IDENTIFIER_LABELS: Record<SystemIdentifierKey, string> = {
  kfo: "КФО",
  building: "корпус",
  section: "секция",
  floor: "этаж",
};

function elementIdentifierValue(element: IfcElementBinding, key: SystemIdentifierKey) {
  if (key === "kfo") return element.kfoCode;
  return element[key];
}

function operationIdentifierValue(operation: SourceOperation, key: SystemIdentifierKey) {
  if (key === "kfo") return operation.kfoCode;
  return operation.location[key];
}

function modelGroupId(element: IfcElementBinding, keys: readonly SystemIdentifierKey[]) {
  return keys.map((key) => elementIdentifierValue(element, key))
    .map((value) => encodeURIComponent(value ?? ""))
    .join("|");
}

function hasCompleteModelWorkIdentity(element: IfcElementBinding, keys: readonly SystemIdentifierKey[]) {
  return keys.every((key) => Boolean(elementIdentifierValue(element, key)));
}

export function matchingScheduleOperations(
  element: IfcElementBinding,
  operations: SourceOperation[],
  keys: readonly SystemIdentifierKey[] = ["kfo"],
) {
  if (!hasCompleteModelWorkIdentity(element, keys)) return [];
  return operations.filter((operation) => keys.every((key) =>
    operationIdentifierValue(operation, key) === elementIdentifierValue(element, key)));
}

export function summarizeModelWorks(
  modelId: BimModelId,
  elements: IfcElementBinding[],
  operations: SourceOperation[],
  keys: readonly SystemIdentifierKey[] = ["kfo"],
): ModelWorkSource {
  const buckets = new Map<string, ModelWorkGroup>();
  let unidentifiedElementCount = 0;
  for (const element of elements) {
    if (!element.kfoCode) {
      unidentifiedElementCount += 1;
      continue;
    }
    const id = modelGroupId(element, keys);
    const current = buckets.get(id);
    if (current) {
      current.elementCount += 1;
      continue;
    }
    const scheduleOperationCount = matchingScheduleOperations(element, operations, keys).length;
    buckets.set(id, {
      id,
      kfoCode: element.kfoCode,
      kfoName: element.kfoName,
      building: element.building,
      section: element.section,
      floor: element.floor,
      elementCount: 1,
      scheduleOperationCount,
    });
  }
  const groupValue = (group: ModelWorkGroup, key: SystemIdentifierKey) =>
    key === "kfo" ? group.kfoCode : group[key];
  const groups = [...buckets.values()].sort((left, right) => keys
    .map((key) => groupValue(left, key) ?? "").join("|")
    .localeCompare(keys.map((key) => groupValue(right, key) ?? "").join("|"), "ru", { numeric: true }));
  return {
    modelId,
    elementCount: elements.length,
    identifiedElementCount: elements.length - unidentifiedElementCount,
    unidentifiedElementCount,
    groups,
  };
}

export async function buildModelWorks(
  scheduleId: string,
  versionId: string,
): Promise<ModelWorksResponse> {
  const snapshot = await getSnapshot(scheduleId, versionId);
  const settings = await readIdentifierSettings();
  const keys = activeIdentifierKeys(settings.identifiers);
  const models = await Promise.all(BIM_MODELS.map(async (model) =>
    summarizeModelWorks(model.id, await readIfcElements(model.id), snapshot.operations, keys)));
  return { scheduleId, versionId, models };
}

type StaticElementMapping = {
  elements: IfcElementBinding[];
  elementIdsByModelWorkId: Map<string, number[]>;
  operationsByModelWorkId: Map<string, SourceOperation[]>;
  modelWorkIdentityById: Map<string, IfcElementBinding>;
};

const elementMappingCache = new Map<string, Promise<StaticElementMapping>>();

async function staticElementMapping(
  cacheKey: string,
  operations: SourceOperation[],
  modelId: BimModelId,
  keys: readonly SystemIdentifierKey[],
) {
  let mapping = elementMappingCache.get(cacheKey);
  if (!mapping) {
    mapping = readIfcElements(modelId).then((sourceElements) => {
      const operationsByModelWorkId = new Map<string, SourceOperation[]>();
      const representativeByModelWorkId = new Map<string, IfcElementBinding>();
      for (const element of sourceElements) {
        if (!hasCompleteModelWorkIdentity(element, keys)) continue;
        const workId = modelGroupId(element, keys);
        if (!representativeByModelWorkId.has(workId)) representativeByModelWorkId.set(workId, element);
      }
      for (const [workId, representative] of representativeByModelWorkId) {
        const matches = matchingScheduleOperations(representative, operations, keys);
        if (matches.length) operationsByModelWorkId.set(workId, matches);
      }
      const elementIdsByModelWorkId = new Map<string, number[]>();
      const elements = sourceElements.map((element) => {
        const identityComplete = hasCompleteModelWorkIdentity(element, keys);
        const candidateWorkId = identityComplete ? modelGroupId(element, keys) : null;
        const operationsForWork = candidateWorkId
          ? operationsByModelWorkId.get(candidateWorkId) ?? []
          : [];
        const workId = operationsForWork.length ? candidateWorkId : null;
        if (workId) {
          const ids = elementIdsByModelWorkId.get(workId) ?? [];
          ids.push(element.expressId);
          elementIdsByModelWorkId.set(workId, ids);
        }
        const workMappingReason = workId
          ? `Работа модели сопоставлена с работой графика; внутри неё ${operationsForWork.length} операций.`
          : identityComplete
            ? `В графике нет работы с теми же идентификаторами: ${keys.map((key) => IDENTIFIER_LABELS[key]).join(", ")}.`
            : `Для идентификации работы модели нужны: ${keys.map((key) => IDENTIFIER_LABELS[key]).join(", ")}.`;
        return { ...element, workId, workMappingReason };
      });
      for (const ids of elementIdsByModelWorkId.values()) ids.sort((left, right) => left - right);
      return {
        elements,
        elementIdsByModelWorkId,
        operationsByModelWorkId,
        modelWorkIdentityById: representativeByModelWorkId,
      };
    });
    elementMappingCache.set(cacheKey, mapping);
  }
  try {
    return await mapping;
  } catch (error) {
    elementMappingCache.delete(cacheKey);
    throw error;
  }
}

type MonitoringContext = {
  baselineVersionId: string | null;
  reportDate: string;
  current: ScheduleSnapshot;
  baselineByOperationId: Map<string, SourceOperation | null>;
  mapping: StaticElementMapping;
};

const monitoringContextCache = new Map<string, Promise<MonitoringContext>>();

export function invalidateMonitoringCaches() {
  elementMappingCache.clear();
  monitoringContextCache.clear();
}

async function prepareMonitoringContext(scheduleId: string, versionId: string, modelId: BimModelId) {
  const settings = await readIdentifierSettings();
  const keys = activeIdentifierKeys(settings.identifiers);
  const cacheKey = `${scheduleId}/${versionId}/${modelId}/${settings.revision}`;
  let prepared = monitoringContextCache.get(cacheKey);
  if (!prepared) {
    prepared = (async (): Promise<MonitoringContext> => {
      const schedule = await getSchedule(scheduleId);
      if (!schedule) throw new Error("График не найден.");
      const version = schedule.versions.find((item) => item.id === versionId);
      if (!version) throw new Error("Версия графика не найдена.");
      const current = await getSnapshot(scheduleId, versionId);
      const baselineVersionId = version.kind === "baseline" ? version.id : version.basedOnBaselineVersionId;
      const baseline = baselineVersionId
        ? baselineVersionId === versionId ? current : await getSnapshot(scheduleId, baselineVersionId)
        : null;
      const baselineMatcher = baseline
        ? createBaselineMatcher(
          baseline.operations,
          current.operations,
          baseline.version.sourceSha256 === current.version.sourceSha256,
        )
        : null;
      const baselineByOperationId = new Map(current.operations.map((operation) => [
        operation.snapshotOperationId,
        baselineMatcher?.(operation)?.operation ?? null,
      ]));
      return {
        baselineVersionId,
        reportDate: version.effectiveStatusDate,
        current,
        baselineByOperationId,
        mapping: await staticElementMapping(cacheKey, current.operations, modelId, keys),
      };
    })();
    monitoringContextCache.set(cacheKey, prepared);
  }
  try {
    return await prepared;
  } catch (error) {
    monitoringContextCache.delete(cacheKey);
    throw error;
  }
}

function compactStatus(status: ReturnType<typeof calculateOperationStatus>): MonitoringStatusValue {
  return {
    area: status.area,
    constructionStatus: status.constructionStatus,
    statusSource: status.statusSource,
    deviation: status.deviation,
    deviationReason: status.deviationReason,
    diagnostics: status.diagnostics,
  };
}

const deviationPriority: Record<ScheduleDeviation, number> = {
  overdue: 6,
  no_data: 5,
  no_baseline: 4,
  not_calculated: 3,
  on_schedule: 2,
  ahead: 1,
};

function aggregateModelWorkStatus(
  workId: string,
  operationStatuses: CalculatedOperationStatus[],
  selectedDate: string,
  reportDate: string,
): CalculatedOperationStatus {
  const usable = operationStatuses.filter((status) => status.constructionStatus !== "diagnostic");
  const constructionStatus = !usable.length
    ? "diagnostic"
    : usable.length === operationStatuses.length && usable.every((status) => status.constructionStatus === "completed")
      ? "completed"
      : usable.length === operationStatuses.length && usable.every((status) => status.constructionStatus === "not_started")
        ? "not_started"
        : "in_progress";
  const criticalDeviation = [...operationStatuses].sort((left, right) =>
    deviationPriority[right.deviation] - deviationPriority[left.deviation])[0];
  const diagnostics = [...new Set(operationStatuses.flatMap((status) => status.diagnostics))];
  return {
    operationId: workId,
    selectedDate,
    reportDate,
    area: selectedDate <= reportDate ? "fact" : "plan",
    constructionStatus,
    statusSource: constructionStatus === "diagnostic"
      ? "diagnostic"
      : operationStatuses.some((status) => status.statusSource === "plan") ? "plan" : "actual",
    deviation: criticalDeviation?.deviation ?? "no_data",
    deviationReason: criticalDeviation
      ? `Наиболее критичное отклонение среди ${operationStatuses.length} операций: ${criticalDeviation.deviationReason}`
      : "У связанной работы нет операций графика.",
    diagnostics,
  };
}

function latestDate(values: Array<string | null>) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function calculateStatuses(context: MonitoringContext, selectedDate: string) {
  const fullByWorkId = new Map<string, ReturnType<typeof calculateOperationStatus>>();
  const statuses: MonitoringStatusPatch["statuses"] = [];
  const statusCounts: Record<string, number> = {};
  for (const operation of context.current.operations) {
    const status = calculateOperationStatus(
      operation,
      context.baselineByOperationId.get(operation.snapshotOperationId) ?? null,
      selectedDate,
      context.reportDate,
    );
    fullByWorkId.set(operation.snapshotOperationId, status);
    statuses.push({ workId: operation.snapshotOperationId, status: compactStatus(status) });
    statusCounts[status.constructionStatus] = (statusCounts[status.constructionStatus] ?? 0) + 1;
  }
  const fullByModelWorkId = new Map<string, CalculatedOperationStatus>();
  const modelWorkStatuses: MonitoringStatusPatch["modelWorkStatuses"] = [];
  for (const [workId, operations] of context.mapping.operationsByModelWorkId) {
    if (!context.mapping.elementIdsByModelWorkId.has(workId)) continue;
    const status = aggregateModelWorkStatus(
      workId,
      operations.map((operation) => fullByWorkId.get(operation.snapshotOperationId)!),
      selectedDate,
      context.reportDate,
    );
    fullByModelWorkId.set(workId, status);
    modelWorkStatuses.push({ workId, status: compactStatus(status) });
  }
  return { fullByWorkId, fullByModelWorkId, statuses, modelWorkStatuses, statusCounts };
}

export async function buildMonitoringStatusPatch(
  scheduleId: string,
  versionId: string,
  selectedDate: string,
  modelId: BimModelId = "structural",
): Promise<MonitoringStatusPatch> {
  const context = await prepareMonitoringContext(scheduleId, versionId, modelId);
  const { statuses, modelWorkStatuses, statusCounts } = calculateStatuses(context, selectedDate);
  return {
    scheduleId,
    versionId,
    modelId,
    selectedDate,
    reportDate: context.reportDate,
    statuses,
    modelWorkStatuses,
    statusCounts,
  };
}

export async function buildMonitoringSnapshot(
  scheduleId: string,
  versionId: string,
  selectedDate: string,
  modelId: BimModelId = "structural",
): Promise<MonitoringSnapshot> {
  const context = await prepareMonitoringContext(scheduleId, versionId, modelId);
  const { current, baselineVersionId, reportDate, mapping } = context;
  const { fullByWorkId, fullByModelWorkId, statusCounts } = calculateStatuses(context, selectedDate);

  const works = current.operations.map((operation) => ({
    workId: operation.snapshotOperationId,
    operationId: operation.snapshotOperationId,
    sourceId: operation.sourceId,
    uid: operation.uid,
    name: operation.name,
    kfoCode: operation.kfoCode,
    kfoName: operation.kfoName,
    building: operation.location.building,
    section: operation.location.section,
    floor: operation.location.floor,
    plannedFinish: operation.finish,
    actualFinish: operation.actualFinish,
    status: fullByWorkId.get(operation.snapshotOperationId)!,
    elementExpressIds: [],
    elementCount: 0,
  }));
  const modelWorks = [...mapping.elementIdsByModelWorkId].map(([workId, elementExpressIds]) => {
    const operations = mapping.operationsByModelWorkId.get(workId) ?? [];
    const identity = mapping.modelWorkIdentityById.get(workId)!;
    const actualFinishes = operations.map((operation) => operation.actualFinish);
    return {
      workId,
      kfoCode: identity.kfoCode!,
      kfoName: identity.kfoName,
      building: identity.building,
      section: identity.section,
      floor: identity.floor,
      operationIds: operations.map((operation) => operation.snapshotOperationId),
      plannedFinish: latestDate(operations.map((operation) => operation.finish)),
      actualFinish: actualFinishes.every(Boolean) ? latestDate(actualFinishes) : null,
      status: fullByModelWorkId.get(workId)!,
      elementExpressIds,
      elementCount: elementExpressIds.length,
    };
  });
  const elements = mapping.elements;
  return {
    scheduleId,
    versionId,
    modelId,
    baselineVersionId,
    selectedDate,
    reportDate,
    works,
    modelWorks,
    elements,
    summary: {
      operationCount: works.length,
      elementCount: elements.length,
      linkedElementCount: elements.filter((element) => element.workId).length,
      unlinkedElementCount: elements.filter((element) => !element.workId).length,
      linkedWorkCount: modelWorks.length,
      mappingReviewCount: elements.filter((element) => element.kfoStatus === "review").length,
      statusCounts,
    },
  };
}

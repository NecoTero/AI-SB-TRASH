import type { CalculatedOperationStatus } from "./status.js";
import type { BimModelId } from "./models.js";

export type IfcMappingStatus = "rule_based" | "review" | "unmapped";

export type IfcElementBinding = {
  expressId: number;
  globalId: string | null;
  ifcClass: string;
  name: string | null;
  kfoCode: string | null;
  kfoName: string | null;
  kfoStatus: IfcMappingStatus;
  mappingReason: string;
  building: string | null;
  section: string | null;
  floor: string | null;
  elementKind: "walls" | "columns" | "slabs" | "beams" | "other";
  workId: string | null;
  workMappingReason: string;
};

export type MonitoringWork = {
  workId: string;
  operationId: string;
  sourceId: string | null;
  uid: string | null;
  name: string;
  kfoCode: string | null;
  kfoName: string | null;
  building: string | null;
  section: string | null;
  floor: string | null;
  plannedFinish: string | null;
  actualFinish: string | null;
  status: CalculatedOperationStatus;
  elementExpressIds: number[];
  elementCount: number;
};

export type MonitoringModelWork = {
  workId: string;
  kfoCode: string;
  kfoName: string | null;
  building: string | null;
  section: string | null;
  floor: string | null;
  operationIds: string[];
  plannedFinish: string | null;
  actualFinish: string | null;
  status: CalculatedOperationStatus;
  elementExpressIds: number[];
  elementCount: number;
};

export type MonitoringSnapshot = {
  scheduleId: string;
  versionId: string;
  modelId: BimModelId;
  baselineVersionId: string | null;
  selectedDate: string;
  reportDate: string;
  works: MonitoringWork[];
  modelWorks: MonitoringModelWork[];
  elements: IfcElementBinding[];
  summary: {
    operationCount: number;
    elementCount: number;
    linkedElementCount: number;
    unlinkedElementCount: number;
    linkedWorkCount: number;
    mappingReviewCount: number;
    statusCounts: Record<string, number>;
  };
};

export type MonitoringStatusValue = Pick<
  CalculatedOperationStatus,
  "area" | "constructionStatus" | "statusSource" | "deviation" | "deviationReason" | "diagnostics"
>;

export type MonitoringStatusPatch = {
  scheduleId: string;
  versionId: string;
  modelId: BimModelId;
  selectedDate: string;
  reportDate: string;
  statuses: Array<{ workId: string; status: MonitoringStatusValue }>;
  modelWorkStatuses: Array<{ workId: string; status: MonitoringStatusValue }>;
  statusCounts: Record<string, number>;
};

export type ModelWorkGroup = {
  id: string;
  kfoCode: string;
  kfoName: string | null;
  building: string | null;
  section: string | null;
  floor: string | null;
  elementCount: number;
  scheduleOperationCount: number;
};

export type ModelWorkSource = {
  modelId: BimModelId;
  elementCount: number;
  identifiedElementCount: number;
  unidentifiedElementCount: number;
  groups: ModelWorkGroup[];
};

export type ModelWorksResponse = {
  scheduleId: string;
  versionId: string;
  models: ModelWorkSource[];
};

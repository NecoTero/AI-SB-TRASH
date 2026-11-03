import { z } from "zod";

export const MAX_SCHEDULE_OPERATIONS = 2_500;

export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(), z.number(), z.boolean(), z.null(),
    z.array(JsonValueSchema), z.record(JsonValueSchema),
  ]),
);

export const ScheduleVersionKindSchema = z.enum(["baseline", "operational"]);

export const SourceFieldSchema = z.object({
  sourceName: z.string(),
  fieldId: z.string().nullable(),
  alias: z.string().nullable(),
  value: JsonValueSchema,
});

export const OperationLocationSchema = z.object({
  building: z.string().nullable(),
  section: z.string().nullable(),
  floor: z.string().nullable(),
  sourcePath: z.array(z.string()),
  evidence: z.array(z.string()),
});

export const SourceOperationSchema = z.object({
  snapshotOperationId: z.string().min(1),
  sourceOrder: z.number().int().nonnegative(),
  uid: z.string().nullable(),
  sourceId: z.string().nullable(),
  wbs: z.string().nullable(),
  outlineNumber: z.string().nullable(),
  outlineLevel: z.number().int().nonnegative().nullable(),
  spiderCode: z.string().nullable(),
  name: z.string(),
  isMilestone: z.boolean(),
  kfoCode: z.string().nullable(),
  kfoName: z.string().nullable(),
  start: z.string().nullable(),
  finish: z.string().nullable(),
  actualStart: z.string().nullable(),
  actualFinish: z.string().nullable(),
  percentComplete: z.number().nullable(),
  calendarUid: z.string().nullable(),
  location: OperationLocationSchema,
  fields: z.array(SourceFieldSchema),
  raw: JsonValueSchema,
});

export const ScheduleHierarchyItemSchema = z.object({
  sourceOrder: z.number().int().nonnegative(),
  uid: z.string().nullable(),
  name: z.string().nullable(),
  outlineNumber: z.string().nullable().optional(),
  outlineLevel: z.number().int().nonnegative().nullable(),
  path: z.array(z.string()),
  summary: z.string().nullable(),
  start: z.string().nullable().optional(),
  finish: z.string().nullable().optional(),
  actualStart: z.string().nullable().optional(),
  actualFinish: z.string().nullable().optional(),
  percentComplete: z.number().nullable().optional(),
});

export const ScheduleVersionMetadataSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: ScheduleVersionKindSchema,
  basedOnBaselineVersionId: z.string().nullable(),
  originalFileName: z.string().min(1),
  sourceSha256: z.string().length(64),
  sourceSize: z.number().int().nonnegative(),
  importedAt: z.string(),
  sourceStatusDate: z.string().nullable(),
  effectiveStatusDate: z.string(),
  statusDateWasOverridden: z.boolean(),
  sourceTaskCount: z.number().int().nonnegative(),
  cmrOperationCount: z.number().int().nonnegative(),
  cmrMilestoneCount: z.number().int().nonnegative(),
  withoutKfoCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export const ProjectScheduleSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  versions: z.array(ScheduleVersionMetadataSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ScheduleSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  scheduleId: z.string(),
  version: ScheduleVersionMetadataSchema,
  projectMetadata: z.record(JsonValueSchema),
  customFieldDefinitions: z.record(z.object({
    fieldId: z.string(),
    alias: z.string().nullable(),
    fieldName: z.string().nullable(),
  })),
  hierarchy: z.array(ScheduleHierarchyItemSchema),
  calendars: z.array(JsonValueSchema),
  operations: z.array(SourceOperationSchema),
});

// Contract only: rules are versioned so links can be recalculated for a new
// schedule snapshot or IFC revision. No matching logic is assumed here.
export const MappingRuleSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(["draft", "confirmed", "retired"]),
  operationKeyFields: z.array(z.string()),
  ifcKeyProperties: z.array(z.string()),
  locationFields: z.array(z.enum(["building", "section", "floor"])),
  createdAt: z.string(),
  note: z.string(),
});

export type ProjectSchedule = z.infer<typeof ProjectScheduleSchema>;
export type ScheduleVersionMetadata = z.infer<typeof ScheduleVersionMetadataSchema>;
export type ScheduleSnapshot = z.infer<typeof ScheduleSnapshotSchema>;
export type SourceOperation = z.infer<typeof SourceOperationSchema>;
export type ScheduleHierarchyItem = z.infer<typeof ScheduleHierarchyItemSchema>;

export type ScheduleTreeRow = {
  rowId: string;
  sourceOrder: number;
  name: string;
  outlineNumber: string | null;
  outlineLevel: number;
  isSummary: boolean;
  isMilestone: boolean;
  start: string | null;
  finish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  percentComplete: number | null;
};


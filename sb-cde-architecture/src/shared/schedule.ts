import { z } from "zod";

export const CellValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const ScheduleVersionKindSchema = z.enum([
  "baseline",
  "operational",
  "unclassified",
]);

export const PredecessorLinkSchema = z.object({
  predecessorUid: z.string().min(1),
  type: z.string().nullable(),
  linkLag: z.string().nullable(),
  lagFormat: z.string().nullable(),
});

export const SourceScheduleOperationSchema = z.object({
  id: z.string().min(1),
  sourceLocator: z.string().min(1),
  sourceOrder: z.number().int().nonnegative(),
  uid: z.string().nullable(),
  sourceId: z.string().nullable(),
  spiderCode: z.string().nullable(),
  workCodePir: z.string().nullable(),
  parentId: z.string().nullable(),
  parentUid: z.string().nullable(),
  outlineLevel: z.number().int().nonnegative().nullable(),
  outlineNumber: z.string().nullable(),
  wbsCode: z.string().nullable(),
  name: z.string().min(1),
  operationType: z.enum(["activity", "summary", "milestone", "unknown"]),
  projectCode: z.string().nullable(),
  cbsCode: z.string().nullable(),
  cbsName: z.string().nullable(),
  kfoCode: z.string().nullable(),
  kfoName: z.string().nullable(),
  sourceStart: z.string().nullable(),
  sourceFinish: z.string().nullable(),
  actualStart: z.string().nullable(),
  actualFinish: z.string().nullable(),
  earlyStart: z.string().nullable(),
  earlyFinish: z.string().nullable(),
  lateStart: z.string().nullable(),
  lateFinish: z.string().nullable(),
  constraintDate: z.string().nullable(),
  deadline: z.string().nullable(),
  stopDate: z.string().nullable(),
  resumeDate: z.string().nullable(),
  duration: z.string().nullable(),
  actualDuration: z.string().nullable(),
  remainingDuration: z.string().nullable(),
  calendarUid: z.string().nullable(),
  volumePlan: z.string().nullable(),
  volumeFact: z.string().nullable(),
  volumeCost: z.string().nullable(),
  percentComplete: z.number().min(0).max(100).nullable(),
  sourceStatus: z.string().nullable(),
  predecessorLinks: z.array(PredecessorLinkSchema),
  fields: z.record(CellValueSchema),
  extendedFields: z.record(CellValueSchema),
  nestedFields: z.record(z.unknown()),
});

const IndicatorFieldMappingSchema = z.object({
  startField: z.string().nullable(),
  finishField: z.string().nullable(),
});

export const ScheduleIndicatorMappingSchema = z.object({
  status: z.enum(["not_configured", "partial", "configured"]),
  planned: IndicatorFieldMappingSchema,
  forecast: IndicatorFieldMappingSchema,
  actual: IndicatorFieldMappingSchema,
  note: z.string(),
});

export const WorkProjectionSchema = z.object({
  status: z.literal("stub"),
  identityParts: z.tuple([
    z.literal("kfo"),
    z.literal("building"),
    z.literal("section"),
    z.literal("floor"),
  ]),
  note: z.string(),
});

export const ScheduleValidationReportSchema = z.object({
  parserVersion: z.string(),
  sourceFileName: z.string(),
  sourceSha256: z.string(),
  projectName: z.string().nullable(),
  projectRevision: z.string().nullable(),
  projectStatusDate: z.string().nullable(),
  taskCountXml: z.number().int().nonnegative(),
  taskCountExported: z.number().int().nonnegative(),
  summaryTasks: z.number().int().nonnegative(),
  nonSummaryTasks: z.number().int().nonnegative(),
  maxOutlineLevel: z.number().int().nonnegative(),
  withCbsCode: z.number().int().nonnegative(),
  withKfoCode: z.number().int().nonnegative(),
  withVolumePlan: z.number().int().nonnegative(),
  withVolumeFact: z.number().int().nonnegative(),
  withActualStart: z.number().int().nonnegative(),
  withActualFinish: z.number().int().nonnegative(),
  predecessorLinks: z.number().int().nonnegative(),
  missingAliases: z.array(z.string()),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const ScheduleVersionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: ScheduleVersionKindSchema,
  baselineSequence: z.number().int().positive().nullable(),
  operationalSequence: z.number().int().positive().nullable(),
  basedOnBaselineVersionId: z.string().nullable(),
  originalFileName: z.string().min(1),
  sourcePath: z.string().min(1),
  sourceSha256: z.string().min(1),
  sourceSize: z.number().int().nonnegative(),
  sourceFormat: z.literal("xml"),
  rootElement: z.string().min(1),
  sourceNodeName: z.string().min(1),
  fieldNames: z.array(z.string()),
  projectMetadata: z.record(CellValueSchema),
  customFieldDictionary: z.record(z.string()),
  sourceOperations: z.array(SourceScheduleOperationSchema),
  indicatorMapping: ScheduleIndicatorMappingSchema,
  workProjection: WorkProjectionSchema,
  validationReport: ScheduleValidationReportSchema,
  warnings: z.array(z.string()),
  createdAt: z.string(),
});

export const ProjectScheduleSchema = z.object({
  schemaVersion: z.literal(5),
  id: z.string().min(1),
  name: z.string().min(1),
  versions: z.array(ScheduleVersionSchema).min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ScheduleAncestorSchema = z.object({
  id: z.string().min(1),
  uid: z.string().nullable(),
  name: z.string().min(1),
  outlineLevel: z.number().int().nonnegative().nullable(),
  outlineNumber: z.string().nullable(),
});

export const ScheduleOperationRowSchema = SourceScheduleOperationSchema.pick({
  id: true,
  sourceLocator: true,
  sourceOrder: true,
  uid: true,
  sourceId: true,
  spiderCode: true,
  parentId: true,
  parentUid: true,
  outlineLevel: true,
  outlineNumber: true,
  wbsCode: true,
  name: true,
  operationType: true,
  projectCode: true,
  cbsCode: true,
  kfoCode: true,
  sourceStart: true,
  sourceFinish: true,
  actualStart: true,
  actualFinish: true,
  volumePlan: true,
  volumeFact: true,
  percentComplete: true,
  sourceStatus: true,
});

export const ScheduleOperationListItemSchema =
  ScheduleOperationRowSchema.extend({
    ancestors: z.array(ScheduleAncestorSchema),
  });

export const ScheduleOperationDetailSchema =
  SourceScheduleOperationSchema.extend({
    ancestors: z.array(ScheduleAncestorSchema),
  });

export const ScheduleOperationsPageSchema = z.object({
  items: z.array(ScheduleOperationListItemSchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

export const ScheduleVersionMetadataSchema = ScheduleVersionSchema.omit({
  sourceOperations: true,
}).extend({
  activityCount: z.number().int().nonnegative(),
  milestoneCount: z.number().int().nonnegative(),
});

export const ProjectScheduleManifestSchema = ProjectScheduleSchema.omit({
  versions: true,
}).extend({
  versions: z.array(ScheduleVersionMetadataSchema).min(1),
});

export const ProjectScheduleSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  versionCount: z.number().int().positive(),
  latestVersionId: z.string().min(1),
  latestVersionLabel: z.string().min(1),
  latestVersionKind: ScheduleVersionKindSchema,
  sourceOperationCount: z.number().int().nonnegative(),
  projectRevision: z.string().nullable(),
  validationErrorCount: z.number().int().nonnegative(),
  validationWarningCount: z.number().int().nonnegative(),
  originalFileName: z.string().min(1),
  sourceSha256s: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CellValue = z.infer<typeof CellValueSchema>;
export type ScheduleVersionKind = z.infer<typeof ScheduleVersionKindSchema>;
export type PredecessorLink = z.infer<typeof PredecessorLinkSchema>;
export type SourceScheduleOperation = z.infer<
  typeof SourceScheduleOperationSchema
>;
export type ScheduleValidationReport = z.infer<
  typeof ScheduleValidationReportSchema
>;
export type ScheduleVersion = z.infer<typeof ScheduleVersionSchema>;
export type ProjectSchedule = z.infer<typeof ProjectScheduleSchema>;
export type ScheduleAncestor = z.infer<typeof ScheduleAncestorSchema>;
export type ScheduleOperationRow = z.infer<typeof ScheduleOperationRowSchema>;
export type ScheduleOperationListItem = z.infer<
  typeof ScheduleOperationListItemSchema
>;
export type ScheduleOperationDetail = z.infer<
  typeof ScheduleOperationDetailSchema
>;
export type ScheduleOperationsPage = z.infer<
  typeof ScheduleOperationsPageSchema
>;
export type ScheduleVersionMetadata = z.infer<
  typeof ScheduleVersionMetadataSchema
>;
export type ProjectScheduleManifest = z.infer<
  typeof ProjectScheduleManifestSchema
>;
export type ProjectScheduleSummary = z.infer<
  typeof ProjectScheduleSummarySchema
>;


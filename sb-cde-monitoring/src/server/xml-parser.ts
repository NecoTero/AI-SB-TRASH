import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { ScheduleSnapshot, ScheduleVersionMetadata, SourceOperation } from "../shared/schedule.js";
import { deriveOperationLocation } from "../shared/location.js";

type RecordValue = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => [
    "Task", "ExtendedAttribute", "Calendar", "Exception", "WeekDay",
    "PredecessorLink", "Baseline",
  ].includes(name),
});

function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (["string", "number", "boolean"].includes(typeof value)) {
    const result = String(value).trim();
    return result.length ? result : null;
  }
  return null;
}

function numeric(value: unknown): number | null {
  const source = text(value);
  if (source === null) return null;
  const result = Number(source.replace(",", "."));
  return Number.isFinite(result) ? result : null;
}

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function projectRoot(parsed: RecordValue): RecordValue {
  return object(parsed.Project ?? Object.values(parsed)[0]);
}

function customDefinitions(project: RecordValue) {
  const result: ScheduleSnapshot["customFieldDefinitions"] = {};
  for (const item of array(object(project.ExtendedAttributes).ExtendedAttribute)) {
    const entry = object(item);
    const fieldId = text(entry.FieldID);
    if (!fieldId) continue;
    result[fieldId] = {
      fieldId,
      alias: text(entry.Alias),
      fieldName: text(entry.FieldName),
    };
  }
  return result;
}

function resolvedFields(task: RecordValue, definitions: ScheduleSnapshot["customFieldDefinitions"]) {
  const fields: SourceOperation["fields"] = [];
  for (const [sourceName, value] of Object.entries(task)) {
    if (sourceName === "ExtendedAttribute") continue;
    fields.push({ sourceName, fieldId: null, alias: null, value });
  }
  for (const item of array(task.ExtendedAttribute)) {
    const entry = object(item);
    const fieldId = text(entry.FieldID);
    if (!fieldId) continue;
    const definition = definitions[fieldId];
    fields.push({
      sourceName: "ExtendedAttribute",
      fieldId,
      alias: definition?.alias ?? definition?.fieldName ?? null,
      value: entry.Value ?? null,
    });
  }
  return fields;
}

function directCustomValue(fields: SourceOperation["fields"], aliases: string[]) {
  const expected = new Set(aliases.map((item) => item.toLocaleLowerCase("ru")));
  const field = fields.find((item) => item.alias && expected.has(item.alias.toLocaleLowerCase("ru")));
  return field ? text(field.value) : null;
}

function derivePaths(tasks: RecordValue[]) {
  const paths: string[][] = [];
  const stack: string[] = [];
  for (const task of tasks) {
    const level = numeric(task.OutlineLevel) ?? 0;
    stack.length = Math.max(0, level);
    stack[level] = text(task.Name) ?? "Без названия";
    paths.push(stack.slice(0, level + 1));
  }
  return paths;
}

function findCmrRange(tasks: RecordValue[]) {
  const rootIndex = tasks.findIndex((task) => (text(task.Name) ?? "").toLocaleLowerCase("ru") === "смр");
  if (rootIndex < 0) throw new Error("В XML не найден раздел «СМР».");
  const rootLevel = numeric(tasks[rootIndex].OutlineLevel) ?? 0;
  let endIndex = tasks.length;
  for (let index = rootIndex + 1; index < tasks.length; index += 1) {
    const level = numeric(tasks[index].OutlineLevel);
    if (level !== null && level <= rootLevel) {
      endIndex = index;
      break;
    }
  }
  return { rootIndex, endIndex };
}

export function inspectScheduleXml(xml: Buffer) {
  const parsed = object(parser.parse(xml.toString("utf8")));
  const project = projectRoot(parsed);
  const tasks = array(object(project.Tasks).Task).map(object);
  if (!tasks.length) throw new Error("В XML не найден Project/Tasks/Task.");
  const definitions = customDefinitions(project);
  const paths = derivePaths(tasks);
  const { rootIndex, endIndex } = findCmrRange(tasks);
  const operations: SourceOperation[] = [];

  for (let index = rootIndex + 1; index < endIndex; index += 1) {
    const task = tasks[index];
    if (text(task.Summary) !== "0") continue;
    const fields = resolvedFields(task, definitions);
    // Stable only inside this immutable snapshot. Cross-version identity is
    // deliberately not guessed until the business key is agreed.
    const snapshotOperationId = `${index}:${text(task.UID) ?? "no-uid"}`;
    operations.push({
      snapshotOperationId,
      sourceOrder: index,
      uid: text(task.UID),
      sourceId: text(task.ID),
      wbs: text(task.WBS),
      outlineNumber: text(task.OutlineNumber),
      outlineLevel: numeric(task.OutlineLevel),
      spiderCode: directCustomValue(fields, ["Spider_Code"]),
      name: text(task.Name) ?? "Без названия",
      isMilestone: text(task.Milestone) === "1",
      kfoCode: directCustomValue(fields, ["Код КФО"]),
      kfoName: directCustomValue(fields, ["КФО"]),
      start: text(task.Start),
      finish: text(task.Finish),
      actualStart: text(task.ActualStart),
      actualFinish: text(task.ActualFinish),
      percentComplete: numeric(task.PercentComplete),
      calendarUid: text(task.CalendarUID),
      location: deriveOperationLocation(paths[index] ?? []),
      fields,
      raw: task,
    });
  }

  const sourceStatusDate = text(project.StatusDate);
  const projectMetadata = Object.fromEntries(
    Object.entries(project).filter(([, value]) => typeof value !== "object" || value === null),
  );
  return {
    sourceSha256: createHash("sha256").update(xml).digest("hex"),
    projectMetadata,
    sourceStatusDate,
    definitions,
    tasks,
    hierarchy: tasks.map((task, index) => ({
      sourceOrder: index,
      uid: text(task.UID),
      name: text(task.Name),
      outlineNumber: text(task.OutlineNumber),
      outlineLevel: numeric(task.OutlineLevel),
      path: paths[index],
      summary: text(task.Summary),
      start: text(task.Start),
      finish: text(task.Finish),
      actualStart: text(task.ActualStart),
      actualFinish: text(task.ActualFinish),
      percentComplete: numeric(task.PercentComplete),
    })),
    calendars: array(object(project.Calendars).Calendar),
    operations,
    effectiveStatusDate: sourceStatusDate?.slice(0, 10) ?? localToday(),
  };
}

export function createVersionMetadata(args: {
  id: string;
  label: string;
  kind: "baseline" | "operational";
  basedOnBaselineVersionId: string | null;
  originalFileName: string;
  sourceSize: number;
  importedAt: string;
  effectiveStatusDate?: string;
  inspection: ReturnType<typeof inspectScheduleXml>;
}): ScheduleVersionMetadata {
  const effectiveStatusDate = args.effectiveStatusDate || args.inspection.effectiveStatusDate;
  return {
    id: args.id,
    label: args.label,
    kind: args.kind,
    basedOnBaselineVersionId: args.basedOnBaselineVersionId,
    originalFileName: args.originalFileName,
    sourceSha256: args.inspection.sourceSha256,
    sourceSize: args.sourceSize,
    importedAt: args.importedAt,
    sourceStatusDate: args.inspection.sourceStatusDate,
    effectiveStatusDate,
    statusDateWasOverridden: Boolean(args.effectiveStatusDate && args.effectiveStatusDate !== args.inspection.sourceStatusDate?.slice(0, 10)),
    sourceTaskCount: args.inspection.tasks.length,
    cmrOperationCount: args.inspection.operations.length,
    cmrMilestoneCount: args.inspection.operations.filter((operation) => operation.isMilestone).length,
    withoutKfoCount: args.inspection.operations.filter((operation) => !operation.kfoCode).length,
    warnings: args.inspection.sourceStatusDate ? [] : ["В XML нет StatusDate: использована текущая локальная дата."],
  };
}


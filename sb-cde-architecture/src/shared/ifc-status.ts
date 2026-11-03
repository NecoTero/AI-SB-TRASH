import { z } from "zod";

export const IfcVisualStatusSchema = z.enum([
  "completed",
  "in_progress",
  "planned",
  "unknown",
]);

export const IfcStatusDefinitionSchema = z.object({
  id: IfcVisualStatusSchema,
  label: z.string().min(1),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  opacity: z.number().min(0).max(1),
  order: z.number().int().nonnegative(),
});

export const IfcStatusCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  defaultStatus: IfcVisualStatusSchema,
  statuses: z.array(IfcStatusDefinitionSchema).length(4),
}).superRefine((catalog, context) => {
  const ids = new Set(catalog.statuses.map((status) => status.id));
  for (const id of IfcVisualStatusSchema.options) {
    if (!ids.has(id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Отсутствует статус ${id}`,
        path: ["statuses"],
      });
    }
  }
});

export type IfcVisualStatus = z.infer<typeof IfcVisualStatusSchema>;
export type IfcStatusDefinition = z.infer<typeof IfcStatusDefinitionSchema>;
export type IfcStatusCatalog = z.infer<typeof IfcStatusCatalogSchema>;
export type IfcStatusCounts = Record<IfcVisualStatus, number>;

export type IfcTimelineOperation = {
  sourceStart: string | null;
  sourceFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  volumePlan?: string | null;
  volumeFact?: string | null;
  volumeCost?: string | null;
  percentComplete: number | null;
};

export type IfcTimelineWork = {
  kfoCode?: string;
  status: string;
  operations: IfcTimelineOperation[];
  elements: Array<{ expressId: number }>;
};

export type IfcKfoBindings = {
  statusAsOf: string;
  kfos: Array<{
    buildings: Array<{
      sections: Array<{
        floors: Array<{ work: IfcTimelineWork }>;
      }>;
    }>;
  }>;
};

export const IFC_TIMELINE_STEP_DAYS = 3;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}/;

function day(value: string | null | undefined) {
  const match = value?.match(DAY_PATTERN);
  return match?.[0] ?? null;
}

function normalizeStoredStatus(status: string): IfcVisualStatus {
  if (status === "completed") return "completed";
  if (status === "in_progress" || status === "overdue") return "in_progress";
  if (status === "planned" || status === "not_started") return "planned";
  return "unknown";
}

export function flattenIfcWorks(bindings: IfcKfoBindings) {
  return bindings.kfos.flatMap((kfo) =>
    kfo.buildings.flatMap((building) =>
      building.sections.flatMap((section) =>
        section.floors.map((floor) => floor.work),
      ),
    ),
  );
}

export function getVisualizedIfcWorks(bindings: IfcKfoBindings) {
  return flattenIfcWorks(bindings).filter((work) => work.kfoCode !== "unknown");
}

export function calculateTimelineWorkStatus(
  work: IfcTimelineWork,
  selectedDay: string,
  sourceStatusDate: string,
): IfcVisualStatus {
  if (work.operations.length === 0) return "unknown";
  if (selectedDay === day(sourceStatusDate)) return normalizeStoredStatus(work.status);

  const statusDay = day(sourceStatusDate);
  const operationStatuses = work.operations.map<IfcVisualStatus>((operation) => {
    const actualFinish = day(operation.actualFinish);
    if (actualFinish && actualFinish <= selectedDay) return "completed";

    const actualStart = day(operation.actualStart);
    if (actualStart && actualStart <= selectedDay) return "in_progress";
    if (actualStart && actualStart > selectedDay) return "planned";

    if (statusDay && selectedDay >= statusDay && (operation.percentComplete ?? 0) >= 100)
      return "completed";
    if (statusDay && selectedDay >= statusDay && (operation.percentComplete ?? 0) > 0)
      return "in_progress";

    const sourceFinish = day(operation.sourceFinish);
    if (sourceFinish && sourceFinish < selectedDay) return "completed";

    const sourceStart = day(operation.sourceStart);
    if (sourceStart && sourceStart <= selectedDay) return "in_progress";
    if (sourceStart || sourceFinish) return "planned";
    return "unknown";
  });

  if (operationStatuses.every((status) => status === "completed")) return "completed";
  if (operationStatuses.some((status) => status === "in_progress" || status === "completed"))
    return "in_progress";
  if (operationStatuses.some((status) => status === "planned")) return "planned";
  return "unknown";
}

export function buildTimelineElementStatuses(
  works: IfcTimelineWork[],
  visibleExpressIds: Iterable<number>,
  selectedDay: string,
  sourceStatusDate: string,
  defaultStatus: IfcVisualStatus,
) {
  const statusByExpressId = new Map<number, IfcVisualStatus>();
  for (const work of works) {
    const workStatus = calculateTimelineWorkStatus(work, selectedDay, sourceStatusDate);
    for (const element of work.elements) {
      statusByExpressId.set(element.expressId, workStatus);
    }
  }

  const counts: IfcStatusCounts = {
    completed: 0,
    in_progress: 0,
    planned: 0,
    unknown: 0,
  };
  for (const expressId of visibleExpressIds) {
    const visualStatus = statusByExpressId.get(expressId) ?? defaultStatus;
    statusByExpressId.set(expressId, visualStatus);
    counts[visualStatus] += 1;
  }
  return { statusByExpressId, counts };
}

function utcDayNumber(value: string) {
  const [year, month, date] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, date) / 86_400_000;
}

function dateFromUtcDayNumber(value: number) {
  return new Date(value * 86_400_000).toISOString().slice(0, 10);
}

function shiftUtcMonth(value: string, amount: number) {
  const [year, month, date] = value.split("-").map(Number);
  const targetMonth = new Date(Date.UTC(year, month - 1 + amount, 1));
  const lastDate = new Date(Date.UTC(
    targetMonth.getUTCFullYear(),
    targetMonth.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  return new Date(Date.UTC(
    targetMonth.getUTCFullYear(),
    targetMonth.getUTCMonth(),
    Math.min(date, lastDate),
  )).toISOString().slice(0, 10);
}

export function dateAtTimelineOffset(start: string, offset: number) {
  const date = new Date((utcDayNumber(start) + offset) * 86_400_000);
  return date.toISOString().slice(0, 10);
}

export function timelineOffset(start: string, value: string) {
  return Math.max(0, Math.round(utcDayNumber(value) - utcDayNumber(start)));
}

export function getIfcTimelineScale(start: string, end: string) {
  const dayCount = Math.max(0, utcDayNumber(end) - utcDayNumber(start));
  const months: Array<{ date: string; offset: number }> = [];
  const weeks: Array<{ date: string; offset: number }> = [];
  let previousMonth = "";
  for (let offset = 0; offset <= dayCount; offset += 1) {
    const date = dateFromUtcDayNumber(utcDayNumber(start) + offset);
    const month = date.slice(0, 7);
    const dateInMonth = Number(date.slice(8, 10));
    if (month !== previousMonth) {
      months.push({ date, offset });
      previousMonth = month;
    }
    if (offset === 0 || dateInMonth === 1 || (dateInMonth - 1) % 7 === 0) {
      weeks.push({ date, offset });
    }
  }
  return { months, weeks };
}

export function getIfcTimelineRange(bindings: IfcKfoBindings) {
  const dates = getVisualizedIfcWorks(bindings)
    .flatMap((work) => work.operations)
    .flatMap((operation) => [
      day(operation.sourceStart),
      day(operation.sourceFinish),
      day(operation.actualStart),
      day(operation.actualFinish),
    ])
    .filter((value): value is string => value !== null);
  const statusDate = day(bindings.statusAsOf) ?? new Date().toISOString().slice(0, 10);
  dates.sort();
  const dataStart = dates[0] ?? statusDate;
  const dataEnd = dates.at(-1) ?? dataStart;
  const start = shiftUtcMonth(dataStart, -1);
  const end = shiftUtcMonth(dataEnd, 1);
  return {
    start,
    end,
    dataStart,
    dataEnd,
    statusDate,
    dayCount: Math.max(0, utcDayNumber(end) - utcDayNumber(start)),
  };
}

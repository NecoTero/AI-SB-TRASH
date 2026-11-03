export type TimelineOperation = {
  snapshotOperationId: string;
  start: string | null;
  finish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
};

export type TimelineBounds = { start: string; end: string };

function isoDay(value: string | null | undefined) {
  return value?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

function datesOf(operation: TimelineOperation) {
  return [operation.start, operation.finish, operation.actualStart, operation.actualFinish]
    .flatMap((value) => isoDay(value) ?? []);
}

function dayNumber(value: string) {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
}

function dateFromDayNumber(value: number) {
  return new Date(value * 86_400_000).toISOString().slice(0, 10);
}

export function operationDateBounds(operations: readonly TimelineOperation[], fallback: string): TimelineBounds {
  const dates = operations.flatMap(datesOf).sort();
  return { start: dates[0] ?? fallback, end: dates.at(-1) ?? fallback };
}

export function focusedOperationDateBounds(
  operations: readonly TimelineOperation[],
  linkedOperationIds: ReadonlySet<string>,
  fullBounds: TimelineBounds,
  paddingDays = 7,
): TimelineBounds | null {
  const dates = operations
    .filter((operation) => linkedOperationIds.has(operation.snapshotOperationId))
    .flatMap(datesOf)
    .sort();
  if (!dates.length) return null;
  return {
    start: dateFromDayNumber(Math.max(dayNumber(fullBounds.start), dayNumber(dates[0]) - paddingDays)),
    end: dateFromDayNumber(Math.min(dayNumber(fullBounds.end), dayNumber(dates.at(-1)!) + paddingDays)),
  };
}

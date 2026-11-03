import type { ScheduleTreeRow } from "../shared/schedule.js";

export function collapsedRowsForLevel(
  rows: ScheduleTreeRow[],
  expandableRows: ReadonlySet<string>,
  rootLevel: number,
  visibleLevel: number,
) {
  return new Set(rows
    .filter((item) => expandableRows.has(item.rowId) && item.outlineLevel - rootLevel + 1 >= visibleLevel)
    .map((item) => item.rowId));
}

export function treeRowsForOperationIds(
  rows: ScheduleTreeRow[],
  operationIds: ReadonlySet<string>,
) {
  const keep = new Set<string>();
  const ancestors: ScheduleTreeRow[] = [];

  for (const row of rows) {
    while (ancestors.length && ancestors.at(-1)!.outlineLevel >= row.outlineLevel) ancestors.pop();
    if (row.isSummary) {
      ancestors.push(row);
      continue;
    }
    if (!operationIds.has(row.rowId)) continue;
    keep.add(row.rowId);
    for (const ancestor of ancestors) keep.add(ancestor.rowId);
  }

  return rows.filter((row) => keep.has(row.rowId));
}

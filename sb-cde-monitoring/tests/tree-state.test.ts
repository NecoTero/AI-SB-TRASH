import { describe, expect, it } from "vitest";
import type { ScheduleTreeRow } from "../src/shared/schedule.js";
import { collapsedRowsForLevel, treeRowsForOperationIds } from "../src/web/tree-state.js";

const row = (rowId: string, outlineLevel: number): ScheduleTreeRow => ({
  rowId, sourceOrder: outlineLevel, name: rowId, outlineNumber: null, outlineLevel,
  isSummary: true, isMilestone: false, start: null, finish: null,
  actualStart: null, actualFinish: null, percentComplete: null,
});

describe("BIM filter in schedule tree", () => {
  it("keeps linked operations together with their hierarchy", () => {
    const rows = [
      row("root", 2),
      row("building-a", 3),
      { ...row("operation-a", 4), isSummary: false },
      row("building-b", 3),
      { ...row("operation-b", 4), isSummary: false },
    ];

    expect(treeRowsForOperationIds(rows, new Set(["operation-b"])).map((item) => item.rowId))
      .toEqual(["root", "building-b", "operation-b"]);
  });
});

describe("Excel-like tree levels", () => {
  const rows = [row("root", 2), row("section", 3), row("floor", 4), row("work", 5)];
  const expandable = new Set(["root", "section", "floor"]);

  it("уровень 1 оставляет только корень", () => {
    expect([...collapsedRowsForLevel(rows, expandable, 2, 1)]).toEqual(["root", "section", "floor"]);
  });

  it("уровень 3 раскрывает первые три уровня", () => {
    expect([...collapsedRowsForLevel(rows, expandable, 2, 3)]).toEqual(["floor"]);
  });
});

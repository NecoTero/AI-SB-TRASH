import { describe, expect, it } from "vitest";
import { focusedOperationDateBounds, operationDateBounds, type TimelineOperation } from "../src/shared/timeline.js";

function operation(id: string, dates: Partial<TimelineOperation>): TimelineOperation {
  return {
    snapshotOperationId: id,
    start: null,
    finish: null,
    actualStart: null,
    actualFinish: null,
    ...dates,
  };
}

describe("границы таймлайна", () => {
  it("учитывает плановые и фактические даты всего графика", () => {
    const bounds = operationDateBounds([
      operation("one", { start: "2026-02-01T08:00:00", finish: "2026-03-01T08:00:00", actualStart: "2026-01-25T08:00:00" }),
      operation("two", { start: "2026-04-01T08:00:00", finish: "2026-05-01T08:00:00", actualFinish: "2026-05-08T08:00:00" }),
    ], "2026-01-01");
    expect(bounds).toEqual({ start: "2026-01-25", end: "2026-05-08" });
  });

  it("строит BIM-фокус только по связанным работам, включая факт и недельный запас", () => {
    const operations = [
      operation("linked", { start: "2026-02-01T08:00:00", finish: "2026-03-01T08:00:00", actualStart: "2026-01-20T08:00:00", actualFinish: "2026-03-05T08:00:00" }),
      operation("other", { start: "2025-01-01T08:00:00", finish: "2027-01-01T08:00:00" }),
    ];
    expect(focusedOperationDateBounds(
      operations,
      new Set(["linked"]),
      { start: "2025-01-01", end: "2027-01-01" },
    )).toEqual({ start: "2026-01-13", end: "2026-03-12" });
  });
});

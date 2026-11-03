import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IfcStatusCatalogSchema,
  IFC_TIMELINE_STEP_DAYS,
  buildTimelineElementStatuses,
  calculateTimelineWorkStatus,
  dateAtTimelineOffset,
  getIfcTimelineRange,
  getIfcTimelineScale,
  getVisualizedIfcWorks,
  timelineOffset,
  type IfcKfoBindings,
  type IfcTimelineWork,
} from "../src/shared/ifc-status.js";

const bindings = JSON.parse(
  readFileSync("data/ifc-kfo/bindings.json", "utf8"),
) as IfcKfoBindings;

describe("IFC status database", () => {
  it("contains the four visual statuses and requested colors", () => {
    const catalog = IfcStatusCatalogSchema.parse(JSON.parse(
      readFileSync("data/ifc-kfo/statuses.json", "utf8"),
    ));
    const statuses = Object.fromEntries(catalog.statuses.map((status) => [status.id, status]));
    expect(statuses.completed).toMatchObject({ label: "Выполнено", color: "#22C55E", opacity: 1 });
    expect(statuses.in_progress).toMatchObject({ label: "В работе", color: "#3B82F6", opacity: 1 });
    expect(statuses.planned).toMatchObject({ label: "Запланировано", color: "#9CA3AF", opacity: 1 });
    expect(statuses.unknown).toMatchObject({ label: "Неизвестно", color: "#FFFFFF", opacity: 0.4 });
  });
});

describe("IFC status timeline", () => {
  const work: IfcTimelineWork = {
    status: "completed",
    elements: [{ expressId: 10 }],
    operations: [{
      sourceStart: "2026-04-01T08:00:00",
      sourceFinish: "2026-04-10T08:00:00",
      actualStart: "2026-04-02T08:00:00",
      actualFinish: "2026-04-08T08:00:00",
      percentComplete: 100,
    }],
  };

  it("changes visual status along the selected date", () => {
    expect(calculateTimelineWorkStatus(work, "2026-04-01", bindings.statusAsOf)).toBe("planned");
    expect(calculateTimelineWorkStatus(work, "2026-04-04", bindings.statusAsOf)).toBe("in_progress");
    expect(calculateTimelineWorkStatus(work, "2026-04-08", bindings.statusAsOf)).toBe("completed");
  });

  it("projects planned operations across their source date interval", () => {
    const plannedWork: IfcTimelineWork = {
      ...work,
      status: "planned",
      operations: [{
        sourceStart: "2026-04-01T08:00:00",
        sourceFinish: "2026-04-10T08:00:00",
        actualStart: null,
        actualFinish: null,
        percentComplete: 0,
      }],
    };
    expect(calculateTimelineWorkStatus(plannedWork, "2026-03-31", bindings.statusAsOf)).toBe("planned");
    expect(calculateTimelineWorkStatus(plannedWork, "2026-04-05", bindings.statusAsOf)).toBe("in_progress");
    expect(calculateTimelineWorkStatus(plannedWork, "2026-04-11", bindings.statusAsOf)).toBe("completed");
  });

  it("keeps unknown work transparent and restores the XML snapshot", () => {
    expect(calculateTimelineWorkStatus({ ...work, operations: [], status: "unknown" }, "2026-07-27", bindings.statusAsOf)).toBe("unknown");
    expect(calculateTimelineWorkStatus({ ...work, status: "in_progress" }, "2026-07-27", bindings.statusAsOf)).toBe("in_progress");
  });

  it("assigns the default transparent status to visible elements without work", () => {
    const result = buildTimelineElementStatuses(
      [work],
      [10, 20],
      "2026-04-04",
      bindings.statusAsOf,
      "unknown",
    );
    expect(result.statusByExpressId.get(10)).toBe("in_progress");
    expect(result.statusByExpressId.get(20)).toBe("unknown");
    expect(result.counts).toMatchObject({ in_progress: 1, unknown: 1 });
  });

  it("excludes elements without a confirmed KFO from visualization", () => {
    const works = getVisualizedIfcWorks(bindings);
    expect(works.every((item) => item.kfoCode !== "unknown")).toBe(true);
    expect(works.flatMap((item) => item.elements)).toHaveLength(392);
  });

  it("builds an inclusive day slider from source and actual dates", () => {
    expect(IFC_TIMELINE_STEP_DAYS).toBe(3);
    const range = getIfcTimelineRange(bindings);
    expect(dateAtTimelineOffset(range.start, range.dayCount)).toBe(range.end);
    expect(timelineOffset(range.start, range.statusDate)).toBeGreaterThanOrEqual(0);
    expect(range.dataStart).toBe("2026-07-31");
    expect(range.dataEnd).toBe("2026-08-09");
    expect(range.start).toBe("2026-06-30");
    expect(range.end).toBe("2026-09-09");
    const scale = getIfcTimelineScale(range.start, range.end);
    expect(scale.months.slice(0, 2)).toEqual([
      { date: "2026-06-30", offset: 0 },
      { date: "2026-07-01", offset: 1 },
    ]);
    expect(scale.weeks.some((tick) => tick.date === "2026-07-08")).toBe(true);
  });
});

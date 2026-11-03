import { describe, expect, it } from "vitest";
import type { SourceOperation } from "../src/shared/schedule.js";
import { calculateOperationStatus } from "../src/shared/status.js";

function operation(patch: Partial<SourceOperation> = {}): SourceOperation {
  return {
    snapshotOperationId: "operation-1", sourceOrder: 1, uid: "1", sourceId: "1",
    wbs: null, outlineNumber: null, outlineLevel: 1, spiderCode: null,
    name: "Работа", isMilestone: false, kfoCode: null, kfoName: null,
    start: "2026-07-10T08:00:00", finish: "2026-07-20T08:00:00",
    actualStart: null, actualFinish: null, percentComplete: 0, calendarUid: null,
    location: { building: null, section: null, floor: null, sourcePath: [], evidence: [] },
    fields: [], raw: {}, ...patch,
  };
}

describe("правила статуса операции СМР", () => {
  const reportDate = "2026-07-15";
  const baseline = operation({ start: "2026-07-10", finish: "2026-07-20" });

  it("считает отчётную дату фактической областью и соблюдает границы", () => {
    expect(calculateOperationStatus(operation({ actualStart: "2026-07-15" }), baseline, "2026-07-15", reportDate))
      .toMatchObject({ area: "fact", constructionStatus: "in_progress" });
    expect(calculateOperationStatus(operation({ actualStart: "2026-07-10", actualFinish: "2026-07-15" }), baseline, "2026-07-15", reportDate))
      .toMatchObject({ area: "fact", constructionStatus: "completed" });
  });

  it("не завершает автоматически пропущенное плановое окончание", () => {
    const result = calculateOperationStatus(
      operation({ start: "2026-07-01", finish: "2026-07-14", actualStart: "2026-07-02" }),
      baseline, "2026-07-25", reportDate,
    );
    expect(result).toMatchObject({ area: "plan", constructionStatus: "in_progress", deviation: "overdue" });
  });

  it("показывает плановое завершение без создания факта", () => {
    const result = calculateOperationStatus(
      operation({ finish: "2026-07-25", actualStart: "2026-07-11", actualFinish: null }),
      baseline, "2026-07-25", reportDate,
    );
    expect(result).toMatchObject({ constructionStatus: "completed", statusSource: "plan", deviation: "overdue" });
  });

  it("сохраняет позднее начало как просрочку до завершения", () => {
    expect(calculateOperationStatus(operation({ actualStart: "2026-07-12" }), baseline, "2026-07-15", reportDate).deviation).toBe("overdue");
    expect(calculateOperationStatus(operation({ actualStart: "2026-07-12", actualFinish: "2026-07-19" }), baseline, "2026-07-19", "2026-07-19").deviation).toBe("ahead");
  });

  it("диагностирует окончание без начала", () => {
    const result = calculateOperationStatus(operation({ actualFinish: "2026-07-12" }), baseline, "2026-07-15", reportDate);
    expect(result.constructionStatus).toBe("diagnostic");
    expect(result.diagnostics).toContain("Фактическое окончание задано без фактического начала.");
  });
});

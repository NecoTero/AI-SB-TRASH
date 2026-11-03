import { describe, expect, it } from "vitest";
import type { MonitoringSnapshot, MonitoringStatusPatch } from "../src/shared/monitoring.js";
import { mergeMonitoringStatusPatch } from "../src/web/monitoring-state.js";

describe("компактное обновление статусов", () => {
  it("обновляет дату и статус, сохраняя статические BIM-данные", () => {
    const current = {
      scheduleId: "schedule", versionId: "version", modelId: "structural", baselineVersionId: null,
      selectedDate: "2026-07-14", reportDate: "2026-07-20",
      works: [{
        workId: "work", operationId: "operation", sourceId: null, uid: null, name: "Работа",
        kfoCode: null, kfoName: null, building: null, section: null, floor: null,
        plannedFinish: "2026-07-15", actualFinish: null,
        elementExpressIds: [10], elementCount: 1,
        status: {
          operationId: "operation", selectedDate: "2026-07-14", reportDate: "2026-07-20",
          area: "fact", constructionStatus: "not_started", statusSource: "actual",
          deviation: "not_calculated", deviationReason: "", diagnostics: [],
        },
      }],
      modelWorks: [{
        workId: "model-work", kfoCode: "204.01", kfoName: "Работа", building: "Корпус А", floor: "Этаж 1",
        operationIds: ["operation"], plannedFinish: "2026-07-15", actualFinish: null,
        elementExpressIds: [10], elementCount: 1,
        status: {
          operationId: "model-work", selectedDate: "2026-07-14", reportDate: "2026-07-20",
          area: "fact", constructionStatus: "not_started", statusSource: "actual",
          deviation: "not_calculated", deviationReason: "", diagnostics: [],
        },
      }],
      elements: [{ expressId: 10 }],
      summary: { operationCount: 1, elementCount: 1, linkedElementCount: 1, unlinkedElementCount: 0, linkedWorkCount: 1, mappingReviewCount: 0, statusCounts: { not_started: 1 } },
    } as unknown as MonitoringSnapshot;
    const patch: MonitoringStatusPatch = {
      scheduleId: "schedule", versionId: "version", modelId: "structural", selectedDate: "2026-07-15", reportDate: "2026-07-20",
      statuses: [{ workId: "work", status: { area: "fact", constructionStatus: "completed", statusSource: "plan", deviation: "on_schedule", deviationReason: "ok", diagnostics: [] } }],
      modelWorkStatuses: [{ workId: "model-work", status: { area: "fact", constructionStatus: "completed", statusSource: "plan", deviation: "on_schedule", deviationReason: "ok", diagnostics: [] } }],
      statusCounts: { completed: 1 },
    };

    const next = mergeMonitoringStatusPatch(current, patch);
    expect(next.selectedDate).toBe("2026-07-15");
    expect(next.works[0].status).toMatchObject({ selectedDate: "2026-07-15", constructionStatus: "completed" });
    expect(next.modelWorks[0].status).toMatchObject({ selectedDate: "2026-07-15", constructionStatus: "completed" });
    expect(next.elements).toBe(current.elements);
    expect(next.works[0].elementExpressIds).toBe(current.works[0].elementExpressIds);
  });
});

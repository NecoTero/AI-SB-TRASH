import { describe, expect, it } from "vitest";
import type { SourceOperation } from "../src/shared/schedule.js";
import { createBaselineMatcher } from "../src/server/operation-identity.js";

function operation(overrides: Partial<SourceOperation>): SourceOperation {
  return {
    snapshotOperationId: "row",
    sourceOrder: 1,
    uid: "11",
    sourceId: "10",
    wbs: null,
    outlineNumber: null,
    outlineLevel: 5,
    spiderCode: "SP-1",
    name: "Бетонирование",
    isMilestone: false,
    kfoCode: "204.02.03.02",
    kfoName: null,
    start: "2026-01-01T08:00:00",
    finish: "2026-01-02T08:00:00",
    actualStart: null,
    actualFinish: null,
    percentComplete: 0,
    calendarUid: null,
    location: {
      building: "Корпус Б",
      section: null,
      floor: "Этаж 1",
      sourcePath: ["СМР", "Корпус Б", "1 этаж", "Плиты перекрытия", "Бетонирование"],
      evidence: [],
    },
    fields: [],
    raw: {},
    ...overrides,
  };
}

describe("межверсионное сопоставление операций", () => {
  it("сопоставляет переименованную двуязычную работу по смысловым признакам", () => {
    const baseline = operation({ snapshotOperationId: "baseline" });
    const current = operation({
      snapshotOperationId: "current",
      uid: "1913",
      sourceId: "1912",
      spiderCode: "NEW-SPIDER",
      name: "Бетонирование / Concrete",
      location: { ...baseline.location, sourcePath: ["СМР", "Монолитный ж/б каркас", "Корпус Б", "1 этаж", "Плиты перекрытия", "Бетонирование / Concrete"] },
    });
    expect(createBaselineMatcher([baseline], [current], false)(current)).toMatchObject({
      operation: { snapshotOperationId: "baseline" },
      strategy: "semantic",
    });
  });

  it("не считает совпадающий ID доказательством при изменившейся структуре", () => {
    const baseline = operation({ snapshotOperationId: "baseline", name: "Старая работа" });
    const current = operation({ snapshotOperationId: "current", name: "Другая работа" });
    expect(createBaselineMatcher([baseline], [current], false)(current)).toBeNull();
  });
});

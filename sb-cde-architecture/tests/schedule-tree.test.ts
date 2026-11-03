import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectScheduleSchema,
  type SourceScheduleOperation,
} from "../src/shared/schedule";
import {
  buildWorkGroupTree,
  buildTreeRows,
  initiallyCollapsed,
  monitoringWorkEntries,
} from "../src/web/SchedulesPage";

function operation(
  uid: string,
  parentUid: string | null,
  sourceOrder: number,
  name: string,
): SourceScheduleOperation {
  return {
    id: uid,
    sourceLocator: "Task[" + sourceOrder + "]",
    sourceOrder,
    uid,
    sourceId: String(sourceOrder),
    spiderCode: null,
    workCodePir: null,
    parentId: parentUid,
    parentUid,
    outlineLevel: sourceOrder,
    outlineNumber: null,
    wbsCode: null,
    name,
    operationType: "summary",
    projectCode: null,
    cbsCode: null,
    cbsName: null,
    kfoCode: null,
    kfoName: null,
    sourceStart: null,
    sourceFinish: null,
    actualStart: null,
    actualFinish: null,
    earlyStart: null,
    earlyFinish: null,
    lateStart: null,
    lateFinish: null,
    constraintDate: null,
    deadline: null,
    stopDate: null,
    resumeDate: null,
    duration: null,
    actualDuration: null,
    remainingDuration: null,
    calendarUid: null,
    volumePlan: null,
    volumeFact: null,
    volumeCost: null,
    percentComplete: null,
    sourceStatus: null,
    predecessorLinks: [],
    fields: {},
    extendedFields: {},
    nestedFields: {},
  };
}

describe("раскрытие дерева расписания", () => {
  const operations = [
    operation("0", null, 0, "МАН16"),
    operation("2", "0", 1, "Концепции"),
    operation("3", "2", 2, "Архитектурные концепции"),
  ];

  it("не возвращает потомков отдельными корнями после сворачивания корня", () => {
    expect(buildTreeRows(operations, new Set(["0"]), "")).toEqual([
      { operation: operations[0], depth: 0 },
    ]);
  });

  it("в исходном виде показывает корень и первый уровень", () => {
    expect(
      buildTreeRows(operations, initiallyCollapsed(operations), "").map(
        ({ operation: item, depth }) => [item.uid, depth],
      ),
    ).toEqual([
      ["0", 0],
      ["2", 1],
    ]);
  });
});

describe("выборка работ для мониторинга СМР", () => {
  const schedule = ProjectScheduleSchema.parse(
    JSON.parse(
      readFileSync(
        resolve(
          "data/schedules/schedule-fe13c646-f17c-480e-ae09-d4bdccd477b9/schedule.json",
        ),
        "utf8",
      ),
    ),
  );
  const entries = monitoringWorkEntries(
    schedule.versions.at(-1)?.sourceOperations ?? [],
  );

  it("оставляет контрольные ветки Shell&Core и служебного Fit-out", () => {
    expect(entries).toHaveLength(1_376);
    expect(
      entries.filter((entry) => entry.section === "Shell&Core"),
    ).toHaveLength(893);
    expect(
      entries.filter((entry) => entry.section.startsWith("Fit-out")),
    ).toHaveLength(483);
  });

  it("сохраняет операции без КФО в отдельной группе", () => {
    expect(entries.filter((entry) => entry.operation.kfoCode)).toHaveLength(232);
    expect(entries.filter((entry) => !entry.operation.kfoCode)).toHaveLength(
      1_144,
    );
    const groups = buildWorkGroupTree(entries, ["building", "floor"]);
    expect(
      groups.find((group) => group.label === "Без кода КФО")?.operationCount,
    ).toBe(1_144);
  });

  it("извлекает исходные названия корпуса и этажа из пути", () => {
    expect(entries.some((entry) => entry.building?.startsWith("Корпус "))).toBe(
      true,
    );
    expect(
      entries.some(
        (entry) =>
          entry.floor?.includes("этаж") ||
          entry.floor?.includes("Подземная часть"),
      ),
    ).toBe(true);
  });
});

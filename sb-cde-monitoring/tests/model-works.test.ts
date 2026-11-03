import { describe, expect, it } from "vitest";
import type { IfcElementBinding } from "../src/shared/monitoring.js";
import type { SourceOperation } from "../src/shared/schedule.js";
import { matchingScheduleOperations, summarizeModelWorks } from "../src/server/monitoring.js";

function element(expressId: number, overrides: Partial<IfcElementBinding>): IfcElementBinding {
  return {
    expressId,
    globalId: null,
    ifcClass: "IFCSLAB",
    name: `Элемент ${expressId}`,
    kfoCode: null,
    kfoName: null,
    kfoStatus: "unmapped",
    mappingReason: "",
    building: "Корпус А",
    section: null,
    floor: "Этаж 1",
    elementKind: "slabs",
    workId: null,
    workMappingReason: "",
    ...overrides,
  };
}

describe("работы из BIM-модели", () => {
  it("группирует элементы по идентификаторам, сравнивает с графиком и объединяет элементы без КФО", () => {
    const operations = [{
      kfoCode: "204.01",
      location: { building: "Корпус А", section: null, floor: "Этаж 1" },
    }] as SourceOperation[];
    const result = summarizeModelWorks("full", [
      element(1, { kfoCode: "204.01", kfoName: "Стены" }),
      element(2, { kfoCode: "204.01", kfoName: "Стены" }),
      element(3, { kfoCode: "204.02", kfoName: "Перекрытия" }),
      element(4, {}),
      element(5, {}),
    ], operations);

    expect(result.elementCount).toBe(5);
    expect(result.identifiedElementCount).toBe(3);
    expect(result.unidentifiedElementCount).toBe(2);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.find((group) => group.kfoCode === "204.01")).toMatchObject({
      elementCount: 2,
      scheduleOperationCount: 1,
    });
    expect(result.groups.find((group) => group.kfoCode === "204.02")).toMatchObject({
      elementCount: 1,
      scheduleOperationCount: 0,
    });
  });

  it("связывает работу модели со всеми операциями той же работы графика", () => {
    const wall = element(1, {
      kfoCode: "204.02.02.05",
      ifcClass: "IFCWALL",
      name: "Стена монолитная",
      building: "Корпус А",
      floor: "Этаж -1",
      elementKind: "walls",
    });
    const operations = [
      {
        snapshotOperationId: "wall",
        kfoCode: "204.02.02.05",
        location: {
          building: "Корпус А",
          section: null,
          floor: "Этаж -1",
          sourcePath: ["Подземная часть", "Стены", "Бетонирование"],
        },
      },
      {
        snapshotOperationId: "column",
        kfoCode: "204.02.02.05",
        location: {
          building: "Корпус А",
          section: null,
          floor: "Этаж -1",
          sourcePath: ["Подземная часть", "Колонны", "Бетонирование"],
        },
      },
    ] as unknown as SourceOperation[];

    expect(matchingScheduleOperations(wall, operations, ["kfo", "building", "floor"]).map((operation) => operation.snapshotOperationId))
      .toEqual(["wall", "column"]);
  });

  it("не считает пустой этаж совпадением с конкретным этажом модели", () => {
    const slab = element(1, {
      kfoCode: "204.02.02.05",
      building: "Корпус А",
      floor: "Этаж -1",
    });
    const operations = [{
      snapshotOperationId: "foundation",
      kfoCode: "204.02.02.05",
      location: {
        building: "Корпус А",
        section: null,
        floor: null,
        sourcePath: ["Фундаментная плита", "Укладка бетонной смеси"],
      },
    }] as SourceOperation[];

    expect(matchingScheduleOperations(slab, operations, ["kfo", "building", "floor"]).map((operation) => operation.snapshotOperationId))
      .toEqual([]);
  });

  it("предпочитает точный этаж операции общему значению без этажа", () => {
    const slab = element(1, {
      kfoCode: "204.02.02.05",
      building: "Корпус А",
      floor: "Этаж -1",
    });
    const operations = [
      {
        snapshotOperationId: "general",
        kfoCode: "204.02.02.05",
        location: { building: "Корпус А", section: null, floor: null, sourcePath: [] },
      },
      {
        snapshotOperationId: "underground",
        kfoCode: "204.02.02.05",
        location: { building: "Корпус А", section: null, floor: "Этаж -1", sourcePath: [] },
      },
    ] as unknown as SourceOperation[];

    expect(matchingScheduleOperations(slab, operations, ["kfo", "building", "floor"]).map((operation) => operation.snapshotOperationId))
      .toEqual(["underground"]);
  });

  it("пересчитывает состав работы по независимо выбранным идентификаторам", () => {
    const modelElement = element(1, {
      kfoCode: "204.02",
      building: "Корпус А",
      section: "Секция 2",
      floor: "Этаж 1",
    });
    const operations = [
      { snapshotOperationId: "same-kfo", kfoCode: "204.02", location: { building: "Корпус Б", section: "Секция 1", floor: "Этаж 5" } },
      { snapshotOperationId: "same-section", kfoCode: "204.02", location: { building: "Корпус Б", section: "Секция 2", floor: "Этаж 5" } },
    ] as SourceOperation[];

    expect(matchingScheduleOperations(modelElement, operations, ["kfo"]).map((operation) => operation.snapshotOperationId))
      .toEqual(["same-kfo", "same-section"]);
    expect(matchingScheduleOperations(modelElement, operations, ["kfo", "section"]).map((operation) => operation.snapshotOperationId))
      .toEqual(["same-section"]);
    expect(matchingScheduleOperations(modelElement, operations, ["kfo", "building", "section"]))
      .toEqual([]);
  });
});

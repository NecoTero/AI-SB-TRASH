import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MONOLITHIC_KFO_CODES,
  calculateOperationStatus,
  calculateWorkStatus,
  operationLocations,
} from "../tools/ifc-kfo/build_ifc_kfo_bindings.mjs";

type Element = {
  id: string;
  ifcClass: string;
  attributes: Record<string, unknown>;
};
type WorkOperation = {
  uid: string | null;
  volumePlan: string | null;
  volumeFact: string | null;
  volumeCost: string | null;
  matchedLocation: {
    buildings: string[];
    sections: string[];
    floors: string[];
  };
};
type Work = {
  kfoCode: string;
  status: string;
  elementCount: number;
  operations: WorkOperation[];
  elements: Element[];
};
type Artifact = {
  schemaVersion: number;
  statusAsOf: string;
  statusCatalog: { path: string; foreignKey: string; primaryKey: string };
  summary: {
    elementCount: number; excludedOpeningCount: number; workCount: number; kfoCount: number;
    elementsWithUnknownKfo: number; elementsWithUnknownSection: number;
    confidenceCounts: Record<string, number>;
  };
  operationSelection: {
    modelKfoCodes: string[];
    sourceOperationCount: number;
    sourceOperationsWithKfo: number;
    modelKfoCandidateOperations: number;
    linkedScheduleOperations: number;
  };
  kfos: Array<{
    code: string; elementCount: number;
    buildings: Array<{ sections: Array<{ floors: Array<{ work: Work }> }> }>;
  }>;
};

const artifact = JSON.parse(readFileSync("data/ifc-kfo/bindings.json", "utf8")) as Artifact;

function allWorks() {
  return artifact.kfos.flatMap((kfo) =>
    kfo.buildings.flatMap((building) =>
      building.sections.flatMap((section) => section.floors.map((floor) => floor.work)),
    ),
  );
}

describe("IFC → КФО bindings", () => {
  it("сохраняет все геометрические конструктивные элементы ровно один раз", () => {
    const works = allWorks();
    const elements = works.flatMap((work) => work.elements);
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.statusAsOf).toBe("2026-07-27T08:00:00");
    expect(artifact.statusCatalog).toEqual({
      path: "data/ifc-kfo/statuses.json",
      foreignKey: "work.status",
      primaryKey: "statuses[].id",
    });
    expect(works).toHaveLength(artifact.summary.workCount);
    expect(elements).toHaveLength(622);
    expect(new Set(elements.map((element) => element.id)).size).toBe(622);
    expect(elements.every((element) => element.ifcClass !== "IFCOPENINGELEMENT")).toBe(true);
    expect(artifact.summary.elementCount).toBe(622);
    expect(artifact.summary.excludedOpeningCount).toBe(305);
    expect(Object.keys(elements[0].attributes)).toEqual(expect.arrayContaining([
      "elementName", "category", "family", "type", "familyAndType", "typeCode",
      "classifierCode", "mark", "volume", "quantity", "units", "elevation",
      "building", "section", "floor", "spatialContainer",
    ]));
  });

  it("строит ожидаемую иерархию КФО и сохраняет неизвестное явно", () => {
    const counts = Object.fromEntries(artifact.kfos.map((kfo) => [kfo.code, kfo.elementCount]));
    expect(counts).toEqual({
      "204.02.03.01": 223,
      "204.02.03.02": 164,
      "204.02.03.08": 5,
      unknown: 230,
    });
    expect(artifact.summary.kfoCount).toBe(4);
    expect(artifact.summary.elementsWithUnknownKfo).toBe(230);
    expect(artifact.summary.elementsWithUnknownSection).toBe(622);
    expect(artifact.summary.confidenceCounts.inherited).toBeUndefined();
  });

  it("не смешивает код КФО родителя и пространственной работы", () => {
    for (const kfo of artifact.kfos) {
      for (const work of allWorks().filter((item) => item.kfoCode === kfo.code)) {
        expect(work.kfoCode).toBe(kfo.code);
        expect(work.elementCount).toBe(work.elements.length);
      }
    }
  });

  it("хранит только связанные с моделью XML-операции и их объёмы", () => {
    const works = allWorks();
    const operations = works.flatMap((work) => work.operations);
    const modelKfoCodes = new Set(artifact.operationSelection.modelKfoCodes);
    expect(artifact.operationSelection).toMatchObject({
      modelKfoCodes: ["204.02.03.01", "204.02.03.02", "204.02.03.08"],
      sourceOperationCount: 3134,
      sourceOperationsWithKfo: 284,
      modelKfoCandidateOperations: 91,
      linkedScheduleOperations: 10,
    });
    expect(works.filter((work) => work.kfoCode !== "unknown")
      .every((work) => modelKfoCodes.has(work.kfoCode))).toBe(true);
    expect(new Set(operations.map((operation) => operation.uid)).size).toBe(10);
    expect(operations.filter((operation) => operation.volumePlan !== null)).toHaveLength(10);
    expect(operations.filter((operation) => operation.volumeFact !== null)).toHaveLength(0);
    expect(operations.every((operation) => operation.volumeCost !== undefined)).toBe(true);
    expect(operations.every((operation) =>
      operation.matchedLocation.buildings.length > 0 ||
      operation.matchedLocation.sections.length > 0 ||
      operation.matchedLocation.floors.length > 0)).toBe(true);
  });

  it("привязывает операции графика только к монолитным КФО", () => {
    const works = allWorks();
    expect(MONOLITHIC_KFO_CODES).toEqual(
      new Set(["204.02.03.01", "204.02.03.02"]),
    );
    expect(
      works
        .filter((work) => !MONOLITHIC_KFO_CODES.has(work.kfoCode))
        .every((work) => work.operations.length === 0),
    ).toBe(true);
  });
});

describe("пространство монолитной операции из XML-дерева", () => {
  it("читает корпус, явную секцию и этаж из всей цепочки предков", () => {
    const operations = [
      { uid: "root", parentUid: null, name: "ЖБ конструкции" },
      { uid: "floor", parentUid: "root", name: "1 этаж на отм. -0.200" },
      { uid: "building", parentUid: "floor", name: "Корпус Б" },
      { uid: "section", parentUid: "building", name: "Секция 2" },
      { uid: "work", parentUid: "section", name: "Бетонирование" },
    ];
    const byUid = new Map(operations.map((operation) => [operation.uid, operation]));

    const location = operationLocations(operations.at(-1), byUid);

    expect([...location.buildings]).toEqual(["Корпус Б"]);
    expect([...location.sections]).toEqual(["Секция 2"]);
    expect([...location.floors]).toEqual(["Этаж 1"]);
  });

  it("не выдумывает секцию, когда такого узла в дереве нет", () => {
    const operations = [
      { uid: "floor", parentUid: null, name: "Подземная часть на отм. -6.350" },
      { uid: "building", parentUid: "floor", name: "Корпус А" },
      { uid: "work", parentUid: "building", name: "Бетонирование" },
    ];
    const byUid = new Map(operations.map((operation) => [operation.uid, operation]));

    const location = operationLocations(operations.at(-1), byUid);

    expect([...location.buildings]).toEqual(["Корпус А"]);
    expect([...location.sections]).toEqual([]);
    expect([...location.floors]).toEqual(["Этаж -1"]);
  });
});

describe("status calculation", () => {
  const asOf = "2026-07-27T08:00:00";
  const operation = {
    actualStart: null, actualFinish: null, percentComplete: 0,
    sourceStart: "2026-07-20T08:00:00", sourceFinish: "2026-07-30T08:00:00",
  };

  it("различает завершение, просрочку, работу, план и отсутствие старта", () => {
    expect(calculateOperationStatus({ ...operation, actualFinish: "2026-07-25T08:00:00" }, asOf)).toBe("completed");
    expect(calculateOperationStatus({ ...operation, sourceFinish: "2026-07-26T08:00:00" }, asOf)).toBe("overdue");
    expect(calculateOperationStatus({ ...operation, actualStart: "2026-07-24T08:00:00" }, asOf)).toBe("in_progress");
    expect(calculateOperationStatus({ ...operation, sourceStart: "2026-08-01T08:00:00" }, asOf)).toBe("planned");
    expect(calculateOperationStatus(operation, asOf)).toBe("not_started");
  });

  it("агрегирует статус работы консервативно", () => {
    expect(calculateWorkStatus(["completed", "completed"])).toBe("completed");
    expect(calculateWorkStatus(["completed", "overdue"])).toBe("overdue");
    expect(calculateWorkStatus(["completed", "planned"])).toBe("in_progress");
    expect(calculateWorkStatus(["planned", "planned"])).toBe("planned");
    expect(calculateWorkStatus([])).toBe("unknown");
  });
});

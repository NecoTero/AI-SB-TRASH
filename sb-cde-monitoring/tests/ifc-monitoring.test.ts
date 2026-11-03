import { describe, expect, it } from "vitest";
import { deriveOperationLocation } from "../src/shared/location.js";
import { readIfcElements, readIfcIdentityParameters } from "../src/server/ifc-model.js";
import { cloneDefaultIdentifiers } from "../src/shared/identifiers.js";

describe("местоположение операции", () => {
  it("читает корпус, секцию и этаж из полного пути дерева", () => {
    expect(deriveOperationLocation([
      "СМР", "1 этаж на отм. -0.200", "Корпус Б", "Секция 2", "Бетонирование",
    ])).toMatchObject({ building: "Корпус Б", section: "Секция 2", floor: "Этаж 1" });
  });

  it("распознаёт подземную часть и не выдумывает секцию", () => {
    expect(deriveOperationLocation(["Подземная часть на отм. -6.350", "Корпус В"]))
      .toMatchObject({ building: "Корпус В", section: null, floor: "Этаж -1" });
  });
});

describe("правила КФО конкретной IFC-модели", () => {
  it("читает обычные и REVIT-варианты идентификационных параметров", () => {
    expect(readIfcIdentityParameters({
      "REVIT.Код по классификатору": "204.02.03.01",
      "REVIT.О_*Здание": "Корпус б",
      "REVIT.О_Этаж": "2",
    })).toEqual({
      kfoCode: "204.02.03.01",
      building: "Корпус Б",
      section: null,
      floor: "Этаж 2",
    });
    expect(readIfcIdentityParameters({
      "Код по классификатору": "204.02.02.05",
      "О_Зона": "Корпус В",
      "О_Этаж": "Этаж -1",
    })).toEqual({
      kfoCode: "204.02.02.05",
      building: "Корпус В",
      section: null,
      floor: "Этаж -1",
    });
    expect(readIfcIdentityParameters({
      "Код по классификатору": "Z0",
      "Комментарии": "204.02.02.02",
      "О_Здание": "Корпус А",
      "О_Этаж": "-1",
    })).toEqual({
      kfoCode: "204.02.02.02",
      building: "Корпус А",
      section: null,
      floor: "Этаж -1",
    });
  });

  it("применяет сохранённый порядок параметров и пользовательские варианты значений", () => {
    const identifiers = cloneDefaultIdentifiers();
    const floor = identifiers.find((identifier) => identifier.key === "floor")!;
    floor.attributes = ["Пользовательский этаж", "Level"];
    floor.valueAliases["Этаж 1"] = ["Первый уровень", "Этаж_01"];
    const section = identifiers.find((identifier) => identifier.key === "section")!;
    section.attributes = ["Custom section"];
    section.valueAliases["Секция 2"] = ["Zone_B"];

    expect(readIfcIdentityParameters({
      "Пользовательский этаж": "Этаж_01",
      Level: "2",
      "Custom section": "Zone_B",
    }, identifiers)).toMatchObject({ floor: "Этаж 1", section: "Секция 2" });
  });

  it("включает 621 физический элемент и воспроизводит контрольные счётчики", async () => {
    const elements = await readIfcElements();
    expect(elements).toHaveLength(621);
    expect(elements.filter((element) => element.kfoStatus === "rule_based")).toHaveLength(551);
    expect(elements.filter((element) => element.kfoStatus === "review")).toHaveLength(70);
    expect(elements.filter((element) => !element.kfoCode)).toHaveLength(0);
    expect(new Set(elements.map((element) => element.expressId)).size).toBe(621);
  });

  it("относит плиты и несущий каркас к первому этажу, сохраняя корпус из IFC", async () => {
    const elements = await readIfcElements();
    const firstFloorStructure = elements.filter((element) =>
      /перекрытие|нескаркас_балка|каркас\s+несущ/i.test(element.name ?? ""),
    );
    expect(firstFloorStructure.length).toBeGreaterThan(0);
    expect(firstFloorStructure.every((element) => element.floor === "Этаж 1")).toBe(true);
    expect(firstFloorStructure.every((element) => /^Корпус\s/u.test(element.building ?? ""))).toBe(true);
  });

  it("читает поэлементные КФО, корпуса и этажи полной модели", async () => {
    const elements = await readIfcElements("full");
    const identified = elements.filter((element) => element.kfoCode);
    const piles = elements.filter((element) => /^свая$/iu.test(element.name?.trim() ?? ""));
    expect(elements).toHaveLength(5491);
    expect(identified).toHaveLength(5491);
    expect(piles).toHaveLength(1407);
    expect(piles.every((element) => element.kfoCode === "204.02.02.02")).toBe(true);
    expect(piles.every((element) => /^Корпус\s/u.test(element.building ?? ""))).toBe(true);
    expect(piles.every((element) => element.floor === "Этаж -1")).toBe(true);
    expect(identified.every((element) => /^\d+(?:\.\d+)+$/u.test(element.kfoCode ?? ""))).toBe(true);
    expect(identified.every((element) => /^Корпус\s/u.test(element.building ?? ""))).toBe(true);
    expect(identified.every((element) => /^Этаж\s-?\d+$/u.test(element.floor ?? ""))).toBe(true);
    expect(new Set(elements.map((element) => element.expressId)).size).toBe(elements.length);
  }, 15_000);
});

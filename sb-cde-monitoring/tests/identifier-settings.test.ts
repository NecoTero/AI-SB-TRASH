import { describe, expect, it } from "vitest";
import { activeIdentifierKeys, cloneDefaultIdentifiers } from "../src/shared/identifiers.js";

describe("активные идентификаторы работ", () => {
  it("оставляет КФО обязательным и включает остальные уровни независимо", () => {
    const identifiers = cloneDefaultIdentifiers();
    expect(activeIdentifierKeys(identifiers)).toEqual(["kfo", "building", "floor"]);

    identifiers.find((item) => item.key === "section")!.isActive = true;
    identifiers.find((item) => item.key === "floor")!.isActive = true;
    identifiers.find((item) => item.key === "kfo")!.isActive = false;

    expect(activeIdentifierKeys(identifiers)).toEqual(["kfo", "building", "section", "floor"]);
  });
});

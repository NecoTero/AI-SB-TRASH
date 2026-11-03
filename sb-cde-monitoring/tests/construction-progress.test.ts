import { describe, expect, it } from "vitest";
import { calculateConstructionProgress } from "../src/shared/construction-progress.js";

describe("накопительный ход строительства", () => {
  it("показывает элемент начиная с самого дня фактического окончания", () => {
    expect(calculateConstructionProgress("2026-07-15T08:00:00", "2026-07-20", "2026-07-14").visible).toBe(false);
    expect(calculateConstructionProgress("2026-07-15T08:00:00", "2026-07-20", "2026-07-15"))
      .toMatchObject({ visible: true, source: "actual", completionDate: "2026-07-15" });
  });

  it("использует плановое окончание, когда фактического нет", () => {
    expect(calculateConstructionProgress(null, "2026-07-20T08:00:00", "2026-07-19").visible).toBe(false);
    expect(calculateConstructionProgress(null, "2026-07-20T08:00:00", "2026-07-20"))
      .toMatchObject({ visible: true, source: "plan", completionDate: "2026-07-20" });
  });

  it("считает фактическое окончание приоритетным и скрывает работы без окончания", () => {
    expect(calculateConstructionProgress("2026-07-25", "2026-07-20", "2026-07-21"))
      .toMatchObject({ visible: false, source: "actual", completionDate: "2026-07-25" });
    expect(calculateConstructionProgress(null, null, "2026-07-21"))
      .toEqual({ visible: false, source: "none", completionDate: null });
  });
});

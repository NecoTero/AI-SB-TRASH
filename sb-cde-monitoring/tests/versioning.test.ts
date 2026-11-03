import { describe, expect, it } from "vitest";
import { nextVersionLabel, versionDeletionBlocker } from "../src/server/repository.js";
import type { ProjectSchedule } from "../src/shared/schedule.js";

const version = (id: string, kind: "baseline" | "operational", base: string | null) => ({
  id, label: id.replace(/^b(\d+)$/u, "Б$1").replace(/^o(\d)(\d+)$/u, "О$1.$2"), kind, basedOnBaselineVersionId: base,
  originalFileName: `${id}.xml`, sourceSha256: "0".repeat(64), sourceSize: 1,
  importedAt: "2026-10-19T00:00:00Z", sourceStatusDate: null,
  effectiveStatusDate: "2026-10-19", statusDateWasOverridden: false,
  sourceTaskCount: 1, cmrOperationCount: 1, cmrMilestoneCount: 0,
  withoutKfoCount: 1, warnings: [],
});

describe("version labels", () => {
  it("нумерует базы и операционные снимки внутри выбранной базы", () => {
    const schedule: ProjectSchedule = {
      schemaVersion: 1, id: "schedule", name: "График",
      createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z",
      versions: [version("b1", "baseline", null), version("o11", "operational", "b1"), version("b2", "baseline", null)],
    };
    expect(nextVersionLabel(schedule, "baseline", null)).toBe("Б3");
    expect(nextVersionLabel(schedule, "operational", "b1")).toBe("О1.2");
    expect(nextVersionLabel(schedule, "operational", "b2")).toBe("О2.1");
  });

  it("не удаляет базу, пока у неё есть операционные версии", () => {
    const schedule: ProjectSchedule = {
      schemaVersion: 1, id: "schedule", name: "График",
      createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z",
      versions: [version("b1", "baseline", null), version("o11", "operational", "b1")],
    };
    expect(versionDeletionBlocker(schedule, "b1")).toContain("Сначала удалите");
    expect(versionDeletionBlocker(schedule, "o11")).toBeNull();
  });

  it("после удаления не перенумеровывает сохранённые версии", () => {
    const schedule: ProjectSchedule = {
      schemaVersion: 1, id: "schedule", name: "График",
      createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z",
      versions: [
        version("b1", "baseline", null),
        version("o11", "operational", "b1"),
        version("o13", "operational", "b1"),
        version("b2", "baseline", null),
        version("o21", "operational", "b2"),
      ],
    };
    expect(schedule.versions.map((item) => item.label)).toEqual(["Б1", "О1.1", "О1.3", "Б2", "О2.1"]);

    schedule.versions = schedule.versions.filter((item) => item.id !== "b1" && item.basedOnBaselineVersionId !== "b1");
    expect(schedule.versions.map((item) => item.label)).toEqual(["Б2", "О2.1"]);
    expect(nextVersionLabel(schedule, "baseline", null)).toBe("Б3");
    expect(nextVersionLabel(schedule, "operational", "b2")).toBe("О2.2");
  });
});


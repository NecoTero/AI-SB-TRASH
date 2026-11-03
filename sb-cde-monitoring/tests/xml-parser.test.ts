import { describe, expect, it } from "vitest";
import { createVersionMetadata, inspectScheduleXml } from "../src/server/xml-parser.js";

const sample = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <StatusDate>2026-07-27T08:00:00</StatusDate>
  <ExtendedAttributes>
    <ExtendedAttribute><FieldID>188744009</FieldID><FieldName>Text20</FieldName><Alias>Код КФО</Alias></ExtendedAttribute>
    <ExtendedAttribute><FieldID>188744016</FieldID><FieldName>Text27</FieldName><Alias>Spider_Code</Alias></ExtendedAttribute>
  </ExtendedAttributes>
  <Calendars><Calendar><UID>1</UID><Name>Основной</Name></Calendar></Calendars>
  <Tasks>
    <Task><UID>1</UID><Name>Проект</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>2</UID><Name>СМР</Name><OutlineLevel>1</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>3</UID><Name>Корпус 1</Name><OutlineLevel>2</OutlineLevel><Summary>1</Summary><ExtendedAttribute><FieldID>188744009</FieldID><Value>PARENT</Value></ExtendedAttribute></Task>
    <Task><UID>4</UID><Name>Работа без КФО</Name><OutlineLevel>3</OutlineLevel><Summary>0</Summary><Milestone>0</Milestone></Task>
    <Task><UID>5</UID><Name>Веха с КФО</Name><OutlineLevel>3</OutlineLevel><Summary>0</Summary><Milestone>1</Milestone><ExtendedAttribute><FieldID>188744009</FieldID><Value>204.1</Value></ExtendedAttribute><ExtendedAttribute><FieldID>188744016</FieldID><Value>S-5</Value></ExtendedAttribute></Task>
    <Task><UID>6</UID><Name>Другой раздел</Name><OutlineLevel>1</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>7</UID><Name>Не СМР</Name><OutlineLevel>2</OutlineLevel><Summary>0</Summary></Task>
  </Tasks>
</Project>`;

describe("inspectScheduleXml", () => {
  it("берёт Summary=0 только из полного поддерева СМР", () => {
    const result = inspectScheduleXml(Buffer.from(sample));
    expect(result.tasks).toHaveLength(7);
    expect(result.operations.map((item) => item.uid)).toEqual(["4", "5"]);
    expect(result.operations[1].isMilestone).toBe(true);
  });

  it("не наследует КФО от родителя и сохраняет повторяемые исходные поля", () => {
    const result = inspectScheduleXml(Buffer.from(sample));
    expect(result.operations[0].kfoCode).toBeNull();
    expect(result.operations[1].kfoCode).toBe("204.1");
    expect(result.operations[1].spiderCode).toBe("S-5");
    expect(result.operations[0].location.sourcePath).toEqual(["Проект", "СМР", "Корпус 1", "Работа без КФО"]);
  });

  it("читает StatusDate и сохраняет календарь", () => {
    const result = inspectScheduleXml(Buffer.from(sample));
    expect(result.sourceStatusDate).toBe("2026-07-27T08:00:00");
    expect(result.calendars).toHaveLength(1);
  });

  it("использует выбранную при импорте отчётную дату вместо даты из XML", () => {
    const inspection = inspectScheduleXml(Buffer.from(sample));
    const version = createVersionMetadata({
      id: "baseline-1",
      label: "Б1",
      kind: "baseline",
      basedOnBaselineVersionId: null,
      originalFileName: "schedule.xml",
      sourceSize: Buffer.byteLength(sample),
      importedAt: "2026-10-22T00:00:00.000Z",
      effectiveStatusDate: "2026-09-15",
      inspection,
    });
    expect(version.sourceStatusDate).toBe("2026-07-27T08:00:00");
    expect(version.effectiveStatusDate).toBe("2026-09-15");
    expect(version.statusDateWasOverridden).toBe(true);
  });
});


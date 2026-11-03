import { describe, expect, it } from "vitest";
import {
  CurrentMapSchema,
  ProjectSchema,
  TaskDraftSchema,
} from "../src/shared/model";
import { ProjectScheduleSchema } from "../src/shared/schedule";
import {
  nextVersionDescriptor,
  parseScheduleXml,
} from "../src/server/schedules";
describe("Stage 1 model", () => {
  it("accepts empty project", () =>
    expect(
      ProjectSchema.parse({
        currentMap: {
          schemaVersion: 1,
          projectId: "local-project",
          revision: 0,
          entities: [],
          relations: [],
          views: [],
        },
        tasks: [],
        drafts: [],
      }).currentMap.revision,
    ).toBe(0));
  it("keeps draft operations separate", () => {
    const d = TaskDraftSchema.parse({
      taskId: "TASK-001",
      featureId: null,
      baseRevision: 0,
      status: "draft",
      implementationStatus: "design",
      operations: [],
      evidence: [],
      updatedAt: null,
      publishedRevision: null,
    });
    expect(d.operations).toEqual([]);
    expect(
      CurrentMapSchema.parse({
        schemaVersion: 1,
        projectId: "local-project",
        revision: 0,
        entities: [],
        relations: [],
        views: [],
      }).entities,
    ).toEqual([]);
  });
});

describe("Project schedules", () => {
  it("reads XML activities, extended attributes and outline hierarchy", () => {
    const buffer = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Project>
  <Name>TEST_PROJECT</Name>
  <Revision>7</Revision>
  <StatusDate>2026-02-01T08:00:00</StatusDate>
  <ExtendedAttributes>
    <ExtendedAttribute>
      <FieldID>188743731</FieldID>
      <Alias>Код КФО</Alias>
    </ExtendedAttribute>
    <ExtendedAttribute>
      <FieldID>188743732</FieldID>
      <Alias>Spider_Code</Alias>
    </ExtendedAttribute>
  </ExtendedAttributes>
  <Tasks>
    <Task>
      <UID>10</UID>
      <ID>100</ID>
      <Name>Раздел</Name>
      <WBS>0</WBS>
      <OutlineNumber>0</OutlineNumber>
      <OutlineLevel>0</OutlineLevel>
      <Start>2026-01-01T08:00:00</Start>
      <Finish>2026-01-31T17:00:00</Finish>
      <PercentComplete>50</PercentComplete>
      <Summary>1</Summary>
    </Task>
    <Task>
      <UID>11</UID>
      <ID>101</ID>
      <Name>Работа</Name>
      <WBS>1</WBS>
      <OutlineNumber>1</OutlineNumber>
      <OutlineLevel>1</OutlineLevel>
      <Start>2026-01-02T08:00:00</Start>
      <Finish>2026-01-10T17:00:00</Finish>
      <PercentComplete>100</PercentComplete>
      <ActualStart>2026-01-03T08:00:00</ActualStart>
      <SP_VolPlan>125.5</SP_VolPlan>
      <PredecessorLink>
        <PredecessorUID>10</PredecessorUID>
        <Type>1</Type>
        <LinkLag>0</LinkLag>
        <LagFormat>7</LagFormat>
      </PredecessorLink>
      <ExtendedAttribute>
        <FieldID>188743731</FieldID>
        <Value>КФО-01</Value>
      </ExtendedAttribute>
      <ExtendedAttribute>
        <FieldID>188743732</FieldID>
        <Value>SP-11</Value>
      </ExtendedAttribute>
    </Task>
  </Tasks>
</Project>`);
    const version = parseScheduleXml(buffer, {
      id: "version-00000000-0000-0000-0000-000000000000",
      label: "Б1",
      kind: "baseline",
      baselineSequence: 1,
      operationalSequence: null,
      basedOnBaselineVersionId: null,
      originalFileName: "test.xml",
      sourcePath: "data/schedules/test/versions/v1/source.xml",
      sourceSha256: "test",
      sourceSize: buffer.length,
      createdAt: "2026-10-09T00:00:00.000Z",
    });
    const schedule = ProjectScheduleSchema.parse({
      schemaVersion: 5,
      id: "schedule-00000000-0000-0000-0000-000000000000",
      name: "Тестовый график",
      versions: [version],
      createdAt: "2026-10-09T00:00:00.000Z",
      updatedAt: "2026-10-09T00:00:00.000Z",
    });
    expect(schedule.versions[0].sourceOperations).toHaveLength(2);
    expect(version.sourceFormat).toBe("xml");
    expect(version.rootElement).toBe("Project");
    expect(version.sourceOperations[0].percentComplete).toBe(50);
    expect(version.sourceOperations[0].operationType).toBe("summary");
    expect(version.sourceOperations[0].sourceStart).toContain("2026-01-01");
    expect(version.indicatorMapping.planned.startField).toBeNull();
    expect(version.indicatorMapping.planned.finishField).toBeNull();
    expect(version.indicatorMapping.forecast.startField).toBeNull();
    expect(version.indicatorMapping.actual.startField).toBe("ActualStart");
    expect(version.sourceOperations[1].parentId).toBe("10");
    expect(version.sourceOperations[1].parentUid).toBe("10");
    expect(version.sourceOperations[1].uid).toBe("11");
    expect(version.sourceOperations[1].sourceId).toBe("101");
    expect(version.sourceOperations[1].spiderCode).toBe("SP-11");
    expect(version.sourceOperations[1].kfoCode).toBe("КФО-01");
    expect(version.sourceOperations[1].volumePlan).toBe("125.5");
    expect(version.sourceOperations[1].predecessorLinks[0].predecessorUid).toBe(
      "10",
    );
    expect(version.sourceOperations[1].fields["Код КФО"]).toBe("КФО-01");
    expect(version.sourceOperations[1].extendedFields["188743731"]).toBe(
      "КФО-01",
    );
    expect(version.sourceOperations[1].nestedFields).toHaveProperty(
      "PredecessorLink",
    );
    expect(version.sourceOperations[1].sourceLocator).toContain("Task[1]");
    expect(version.projectMetadata.Revision).toBe("7");
    expect(version.validationReport.taskCountExported).toBe(2);
    expect(version.validationReport.predecessorLinks).toBe(1);
    expect(version.workProjection.status).toBe("stub");
  });

  it("rejects DTD and XML entities", () => {
    const buffer = Buffer.from(`<?xml version="1.0"?>
<!DOCTYPE Project [<!ENTITY unsafe SYSTEM "file:///etc/passwd">]>
<Project><Tasks><Task><UID>1</UID><Name>&unsafe;</Name></Task></Tasks></Project>`);
    expect(() =>
      parseScheduleXml(buffer, {
        id: "version-00000000-0000-0000-0000-000000000000",
        label: "Б1",
        kind: "baseline",
        baselineSequence: 1,
        operationalSequence: null,
        basedOnBaselineVersionId: null,
        originalFileName: "unsafe.xml",
        sourcePath: "data/schedules/test/versions/v1/source.xml",
        sourceSha256: "test",
        sourceSize: buffer.length,
        createdAt: "2026-10-09T00:00:00.000Z",
      }),
    ).toThrow("DTD");
  });

  it("numbers operational versions within their immutable baseline", () => {
    const baseline1 = parseScheduleXml(
      Buffer.from(
        "<Project><Tasks><Task><UID>1</UID><Name>A</Name><OutlineLevel>0</OutlineLevel></Task></Tasks></Project>",
      ),
      {
        ...nextVersionDescriptor([], "baseline"),
        originalFileName: "b1.xml",
        sourcePath: "data/schedules/test/b1.xml",
        sourceSha256: "b1",
        sourceSize: 1,
        createdAt: "2026-10-09T00:00:00.000Z",
      },
    );
    const operational1 = nextVersionDescriptor([baseline1], "operational");
    expect(operational1.label).toBe("О1.1");
    expect(operational1.basedOnBaselineVersionId).toBe(baseline1.id);
    const operationalVersion1 = {
      ...baseline1,
      ...operational1,
    };
    expect(
      nextVersionDescriptor(
        [baseline1, operationalVersion1],
        "operational",
      ).label,
    ).toBe("О1.2");

    const baseline2 = nextVersionDescriptor([baseline1], "baseline");
    expect(baseline2.label).toBe("Б2");
    const baselineVersion2 = { ...baseline1, ...baseline2 };
    expect(
      nextVersionDescriptor(
        [baseline1, operationalVersion1, baselineVersion2],
        "operational",
      ).label,
    ).toBe("О2.1");
  });
});

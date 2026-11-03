import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  ProjectScheduleManifestSchema,
  ProjectScheduleSchema,
  ScheduleOperationDetailSchema,
  ScheduleOperationRowSchema,
  ScheduleOperationsPageSchema,
  ScheduleVersionKindSchema,
  ScheduleVersionSchema,
  type CellValue,
  type ProjectSchedule,
  type ProjectScheduleSummary,
  type ScheduleVersion,
  type ScheduleVersionKind,
  type SourceScheduleOperation,
} from "../shared/schedule.js";

const schedulesDir = path.resolve("data", "schedules");
export const scheduleInboxDir = path.resolve("data", "imports", "schedules");
const supportedExtension = ".xml";

type XmlScalar = string | number | boolean | null;
type XmlNode = Record<string, unknown>;
type ColumnKey =
  | "uid"
  | "id"
  | "spiderCode"
  | "workCodePir"
  | "parentId"
  | "outlineLevel"
  | "outlineNumber"
  | "wbsCode"
  | "name"
  | "operationType"
  | "projectCode"
  | "cbsCode"
  | "cbsName"
  | "kfoCode"
  | "kfoName"
  | "sourceStart"
  | "sourceFinish"
  | "actualStart"
  | "actualFinish"
  | "earlyStart"
  | "earlyFinish"
  | "lateStart"
  | "lateFinish"
  | "constraintDate"
  | "deadline"
  | "stopDate"
  | "resumeDate"
  | "duration"
  | "actualDuration"
  | "remainingDuration"
  | "calendarUid"
  | "volumePlan"
  | "volumeFact"
  | "volumeCost"
  | "percentComplete"
  | "status";

const aliases: Record<ColumnKey, string[]> = {
  uid: ["uid", "task uid"],
  id: ["id", "guid", "идентификатор", "activity id", "task id"],
  spiderCode: ["spider code", "spider_code", "Spider_Code"],
  workCodePir: ["код работ из раздела ПИР"],
  parentId: [
    "parent id",
    "parent uid",
    "parentid",
    "parentuid",
    "родитель",
    "ид родителя",
    "код родителя",
  ],
  outlineLevel: [
    "outline level",
    "outlinelevel",
    "уровень",
    "уровень иерархии",
    "уровень структуры",
  ],
  outlineNumber: ["outline number", "outlinenumber"],
  wbsCode: ["wbs", "код wbs", "шифр wbs"],
  name: [
    "name",
    "task name",
    "activity name",
    "наименование",
    "наименование работы",
    "название",
    "работа",
  ],
  operationType: ["type", "activity type", "operation type", "тип", "тип операции"],
  projectCode: ["код проекта", "project code"],
  cbsCode: ["код CBS", "cbs code"],
  cbsName: ["CBS"],
  kfoCode: ["код КФО", "kfo code"],
  kfoName: ["КФО", "kfo"],
  sourceStart: [
    "start",
    "начало",
  ],
  sourceFinish: [
    "finish",
    "окончание",
  ],
  actualStart: [
    "actual start",
    "actualstart",
    "start actual",
    "фактическое начало",
    "начало факт",
  ],
  actualFinish: [
    "actual finish",
    "actualfinish",
    "finish actual",
    "фактическое окончание",
    "окончание факт",
  ],
  earlyStart: ["early start", "earlystart"],
  earlyFinish: ["early finish", "earlyfinish"],
  lateStart: ["late start", "latestart"],
  lateFinish: ["late finish", "latefinish"],
  constraintDate: ["constraint date", "constraintdate"],
  deadline: ["deadline", "крайний срок"],
  stopDate: ["stop", "stop date"],
  resumeDate: ["resume", "resume date"],
  duration: ["duration", "длительность", "продолжительность"],
  actualDuration: ["actual duration", "actualduration"],
  remainingDuration: ["remaining duration", "remainingduration"],
  calendarUid: ["calendar uid", "calendaruid"],
  volumePlan: ["SP_VolPlan", "плановый объём"],
  volumeFact: ["SP_VolFact", "фактический объём"],
  volumeCost: ["SP_VolCost", "стоимостной объём"],
  percentComplete: [
    "percent complete",
    "percentcomplete",
    "% complete",
    "выполнение",
    "процент выполнения",
    "% выполнения",
  ],
  status: ["status", "статус", "состояние"],
};

const expectedCustomAliases = [
  "Код проекта",
  "Код CBS",
  "CBS",
  "Код КФО",
  "КФО",
  "Spider_Code",
  "Код работ из раздела ПИР",
];

const taskTagNames = new Set([
  "task",
  "activity",
  "operation",
  "work",
  "работа",
]);

function normalizeName(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/([a-zа-я])([A-ZА-Я])/g, "$1 $2")
    .toLocaleLowerCase("ru")
    .replace(/[._/\\-]+/g, " ")
    .replace(/\s+/g, " ");
}

function localTagName(value: string) {
  return value.includes(":") ? (value.split(":").pop() ?? value) : value;
}

function isNode(value: unknown): value is XmlNode {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function isScalar(value: unknown): value is XmlScalar {
  return (
    value === null || ["string", "number", "boolean"].includes(typeof value)
  );
}

function asArray(value: unknown) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function scalarText(value: unknown) {
  if (!isScalar(value) || value === null || value === "") return null;
  return String(value).trim() || null;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value ?? "")
    .trim()
    .replace(",", ".")
    .replace("%", "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: unknown) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeName(value);
  return ["1", "true", "yes", "да"].includes(normalized);
}

function percentValue(value: unknown) {
  const parsed = numberValue(value);
  if (parsed === null) return null;
  return parsed;
}

function decodeXml(buffer: Buffer) {
  let encoding = "utf-8";
  if (buffer[0] === 0xff && buffer[1] === 0xfe) encoding = "utf-16le";
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) encoding = "utf-16be";
  else {
    const declaration = buffer
      .subarray(0, 256)
      .toString("ascii")
      .match(/encoding\s*=\s*["']([^"']+)["']/i);
    if (declaration) encoding = declaration[1].toLocaleLowerCase();
  }
  const aliases: Record<string, string> = {
    utf8: "utf-8",
    "utf-8": "utf-8",
    "utf-16": "utf-16le",
    utf16: "utf-16le",
    "utf-16le": "utf-16le",
    "utf-16be": "utf-16be",
    "windows-1251": "windows-1251",
    cp1251: "windows-1251",
  };
  const supported = aliases[encoding];
  if (!supported)
    throw new Error(`Кодировка XML «${encoding}» пока не поддерживается`);
  return new TextDecoder(supported).decode(buffer).replace(/^\uFEFF/, "");
}

function collectDefinitionAliases(root: unknown) {
  const result = new Map<string, string>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNode(value) || seen.has(value)) return;
    seen.add(value);
    const entries = Object.entries(value);
    const normalized = new Map(
      entries.map(([key, item]) => [normalizeName(localTagName(key)), item]),
    );
    const fieldId = scalarText(
      normalized.get("field id") ?? normalized.get("fieldid"),
    );
    const label = scalarText(
      normalized.get("alias") ??
        normalized.get("field name") ??
        normalized.get("fieldname") ??
        null,
    );
    if (fieldId && label) result.set(fieldId, label);
    for (const [, item] of entries) visit(item);
  };
  visit(root);
  return result;
}

function directEntry(node: XmlNode, name: string) {
  return Object.entries(node).find(
    ([key]) => normalizeName(localTagName(key)) === normalizeName(name),
  )?.[1];
}

function directScalar(node: XmlNode, name: string) {
  return scalarText(directEntry(node, name));
}

function microsoftProjectContext(parsed: XmlNode) {
  const rootEntry = Object.entries(parsed).find(
    ([key]) => normalizeName(localTagName(key)) === "project",
  );
  if (!rootEntry || !isNode(rootEntry[1])) return null;
  const project = rootEntry[1];
  const tasksContainer = directEntry(project, "Tasks");
  if (!isNode(tasksContainer)) return null;
  const taskValue = directEntry(tasksContainer, "Task");
  const tasks = asArray(taskValue).filter(isNode);
  const projectMetadata: Record<string, CellValue> = {};
  for (const [key, value] of Object.entries(project)) {
    if (isScalar(value)) projectMetadata[localTagName(key)] = value;
  }
  return {
    project,
    projectMetadata,
    tasks: tasks.map((node, index) => ({
      node,
      locator: `$.Project.Tasks.Task[${index}]`,
      tagName: "Task",
    })),
  };
}

function collectPredecessorLinks(node: XmlNode) {
  const links: Array<{
    predecessorUid: string;
    type: string | null;
    linkLag: string | null;
    lagFormat: string | null;
  }> = [];
  for (const [key, value] of Object.entries(node)) {
    if (normalizeName(localTagName(key)) !== "predecessor link") continue;
    for (const item of asArray(value)) {
      if (!isNode(item)) continue;
      const predecessorUid = directScalar(item, "PredecessorUID");
      if (!predecessorUid) continue;
      links.push({
        predecessorUid,
        type: directScalar(item, "Type"),
        linkLag: directScalar(item, "LinkLag"),
        lagFormat: directScalar(item, "LagFormat"),
      });
    }
  }
  return links;
}

function collectExtendedFields(node: XmlNode) {
  const result: Record<string, CellValue> = {};
  for (const [key, value] of Object.entries(node)) {
    if (normalizeName(localTagName(key)) !== "extended attribute") continue;
    for (const item of asArray(value)) {
      if (!isNode(item)) continue;
      const fieldId = directScalar(item, "FieldID");
      const fieldValue = directEntry(item, "Value");
      if (fieldId && isScalar(fieldValue)) result[fieldId] = fieldValue;
    }
  }
  return result;
}

function collectNestedFields(node: XmlNode) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (isScalar(value)) continue;
    const name = localTagName(key);
    if (normalizeName(name) === "extended attribute") continue;
    result[name] = value;
  }
  return result;
}

type TaskCandidate = { node: XmlNode; locator: string; tagName: string };

function looksLikeTask(node: XmlNode) {
  const keys = new Set(
    Object.keys(node).map((key) => normalizeName(localTagName(key))),
  );
  const recognized = Object.values(aliases)
    .flat()
    .filter((alias) => keys.has(normalizeName(alias))).length;
  const hasIdentity = [...aliases.id, ...aliases.name].some((alias) =>
    keys.has(normalizeName(alias)),
  );
  return hasIdentity && recognized >= 2;
}

function collectTaskCandidates(root: unknown) {
  const result: TaskCandidate[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, locator: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${locator}[${index}]`));
      return;
    }
    if (!isNode(value) || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      const tagName = localTagName(key);
      const normalizedTag = normalizeName(tagName);
      const values = asArray(child);
      values.forEach((item, index) => {
        const childLocator = `${locator}.${tagName}${values.length > 1 ? `[${index}]` : ""}`;
        if (
          taskTagNames.has(normalizedTag) &&
          isNode(item) &&
          looksLikeTask(item)
        ) {
          result.push({ node: item, locator: childLocator, tagName });
        }
        visit(item, childLocator);
      });
    }
  };
  visit(root, "$");
  return result;
}

function flattenTaskNode(
  node: XmlNode,
  definitionAliases: Map<string, string>,
) {
  const fields: Record<string, CellValue> = {};
  for (const [rawKey, rawValue] of Object.entries(node)) {
    const key = localTagName(rawKey);
    if (isScalar(rawValue)) {
      fields[key] = rawValue;
      continue;
    }
    if (normalizeName(key) !== "extended attribute") continue;
    for (const entry of asArray(rawValue)) {
      if (!isNode(entry)) continue;
      const normalized = new Map(
        Object.entries(entry).map(([entryKey, value]) => [
          normalizeName(localTagName(entryKey)),
          value,
        ]),
      );
      const fieldId = scalarText(
        normalized.get("field id") ?? normalized.get("fieldid"),
      );
      const value = normalized.get("value");
      if (!fieldId || !isScalar(value)) continue;
      fields[definitionAliases.get(fieldId) ?? `ExtendedAttribute:${fieldId}`] =
        value;
    }
  }
  return fields;
}

function fieldLookup(fields: Record<string, CellValue>) {
  const normalized = new Map(
    Object.entries(fields).map(([key, value]) => [normalizeName(key), value]),
  );
  return (key: ColumnKey) => {
    for (const alias of aliases[key]) {
      const value = normalized.get(normalizeName(alias));
      if (value !== undefined) return value;
    }
    return null;
  };
}

function detectActivityType(
  get: (key: ColumnKey) => CellValue | null,
  fields: Record<string, CellValue>,
  name: string,
): SourceScheduleOperation["operationType"] {
  const normalized = normalizeName(get("operationType"));
  if (normalized.includes("вех") || normalized.includes("milestone"))
    return "milestone";
  if (
    normalized.includes("итог") ||
    normalized.includes("сумм") ||
    normalized.includes("summary")
  )
    return "summary";
  const byName = new Map(
    Object.entries(fields).map(([key, value]) => [normalizeName(key), value]),
  );
  if (booleanValue(byName.get("milestone"))) return "milestone";
  if (booleanValue(byName.get("summary"))) return "summary";
  if (/вех/i.test(name)) return "milestone";
  return "activity";
}

export function parseScheduleXml(
  buffer: Buffer,
  metadata: {
    id: string;
    label: string;
    kind: ScheduleVersionKind;
    baselineSequence: number | null;
    operationalSequence: number | null;
    basedOnBaselineVersionId: string | null;
    originalFileName: string;
    sourcePath: string;
    sourceSha256: string;
    sourceSize: number;
    createdAt: string;
  },
): ScheduleVersion {
  const xml = decodeXml(buffer);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("DTD и пользовательские XML-сущности не поддерживаются");
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(
      `Некорректный XML: ${validation.err.msg}, строка ${validation.err.line}`,
    );
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(xml) as unknown;
  if (!isNode(parsed)) throw new Error("XML не содержит корневого элемента");
  const rootElement = localTagName(
    Object.keys(parsed).find((key) => !key.startsWith("?")) ?? "XML",
  );
  const projectContext = microsoftProjectContext(parsed);
  const definitionAliases = collectDefinitionAliases(parsed);
  const candidates = projectContext?.tasks.length
    ? projectContext.tasks
    : collectTaskCandidates(parsed);
  if (!candidates.length) {
    throw new Error(
      "В XML не найдены исходные операции Project/Tasks/Task, Activity, Operation или Work",
    );
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const usedIds = new Map<string, number>();
  const seenUids = new Set<string>();
  const levelStack = new Map<
    number,
    { id: string; uid: string | null; wbs: string | null }
  >();
  const fieldNames = new Set<string>();
  const sourceOperations: SourceScheduleOperation[] = [];

  candidates.forEach((candidate, index) => {
    const fields = flattenTaskNode(candidate.node, definitionAliases);
    Object.keys(fields).forEach((field) => fieldNames.add(field));
    const get = fieldLookup(fields);
    const rawName = scalarText(get("name"));
    const name = rawName ?? "Без названия";
    if (!rawName)
      warnings.push(
        `${candidate.locator}: отсутствует Name; показана техническая подпись.`,
      );
    const uid = scalarText(get("uid"));
    const sourceId = scalarText(get("id"));
    const baseId = uid ?? sourceId ?? `task-${index + 1}`;
    const occurrence = (usedIds.get(baseId) ?? 0) + 1;
    usedIds.set(baseId, occurrence);
    const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
    if (occurrence > 1) {
      const message = `Дублирующий идентификатор «${baseId}» в ${candidate.locator}`;
      if (projectContext && uid) errors.push(message);
      else warnings.push(`${message}; создан ID «${id}».`);
    }
    if (uid) {
      if (seenUids.has(uid))
        errors.push(`UID=${uid}: дублирующийся UID в исходном XML`);
      seenUids.add(uid);
    }
    const levelRaw = numberValue(get("outlineLevel"));
    const outlineLevel =
      levelRaw === null ? null : Math.max(0, Math.trunc(levelRaw));
    const wbsCode = scalarText(get("wbsCode"));
    const outlineNumber = scalarText(get("outlineNumber"));
    const parent =
      outlineLevel === null ? null : levelStack.get(outlineLevel - 1);
    const parentId = scalarText(get("parentId")) ?? parent?.id ?? null;
    const parentUid = parent?.uid ?? null;
    if (projectContext && (uid === null || outlineLevel === null))
      errors.push(
        `${candidate.locator}: для Microsoft Project Task обязательны UID и OutlineLevel`,
      );
    if (projectContext && outlineLevel !== null && outlineLevel > 0 && !parent)
      errors.push(
        `UID=${uid ?? "?"}: разрыв OutlineLevel; уровень ${outlineLevel}`,
      );
    if (
      projectContext &&
      wbsCode !== null &&
      outlineNumber !== null &&
      wbsCode !== outlineNumber
    )
      warnings.push(
        `UID=${uid ?? "?"}: WBS=${wbsCode} отличается от OutlineNumber=${outlineNumber}`,
      );
    if (projectContext && wbsCode && outlineLevel !== null) {
      const expectedLevel = wbsCode === "0" ? 0 : wbsCode.split(".").length;
      if (expectedLevel !== outlineLevel)
        warnings.push(
          `UID=${uid ?? "?"}: глубина WBS ${expectedLevel} не равна OutlineLevel ${outlineLevel}`,
        );
      if (
        parent &&
        outlineLevel > 1 &&
        parent.wbs &&
        !wbsCode.startsWith(`${parent.wbs}.`)
      )
        warnings.push(
          `UID=${uid ?? "?"}: WBS ${wbsCode} не вложен в WBS родителя ${parent.wbs}`,
        );
    }
    if (outlineLevel !== null) {
      levelStack.set(outlineLevel, { id, uid, wbs: wbsCode });
      for (const level of [...levelStack.keys()])
        if (level > outlineLevel) levelStack.delete(level);
    }
    sourceOperations.push({
      id,
      sourceLocator: candidate.locator,
      sourceOrder: index,
      uid,
      sourceId,
      spiderCode: scalarText(get("spiderCode")),
      workCodePir: scalarText(get("workCodePir")),
      parentId,
      parentUid,
      outlineLevel,
      outlineNumber,
      wbsCode,
      name,
      operationType: detectActivityType(get, fields, name),
      projectCode: scalarText(get("projectCode")),
      cbsCode: scalarText(get("cbsCode")),
      cbsName: scalarText(get("cbsName")),
      kfoCode: scalarText(get("kfoCode")),
      kfoName: scalarText(get("kfoName")),
      sourceStart: scalarText(get("sourceStart")),
      sourceFinish: scalarText(get("sourceFinish")),
      actualStart: scalarText(get("actualStart")),
      actualFinish: scalarText(get("actualFinish")),
      earlyStart: scalarText(get("earlyStart")),
      earlyFinish: scalarText(get("earlyFinish")),
      lateStart: scalarText(get("lateStart")),
      lateFinish: scalarText(get("lateFinish")),
      constraintDate: scalarText(get("constraintDate")),
      deadline: scalarText(get("deadline")),
      stopDate: scalarText(get("stopDate")),
      resumeDate: scalarText(get("resumeDate")),
      duration: scalarText(get("duration")),
      actualDuration: scalarText(get("actualDuration")),
      remainingDuration: scalarText(get("remainingDuration")),
      calendarUid: scalarText(get("calendarUid")),
      volumePlan: scalarText(get("volumePlan")),
      volumeFact: scalarText(get("volumeFact")),
      volumeCost: scalarText(get("volumeCost")),
      percentComplete: percentValue(get("percentComplete")),
      sourceStatus: scalarText(get("status")),
      predecessorLinks: collectPredecessorLinks(candidate.node),
      fields,
      extendedFields: collectExtendedFields(candidate.node),
      nestedFields: collectNestedFields(candidate.node),
    });
  });

  if (!sourceOperations.length)
    throw new Error("В найденных узлах XML нет исходных операций");
  if (errors.length)
    throw new Error(
      `Критические ошибки структуры XML: ${errors.slice(0, 3).join("; ")}`,
    );
  if (
    !sourceOperations.some(
      (operation) => operation.parentId || operation.outlineLevel !== null,
    )
  ) {
    warnings.push(
      "Иерархия не распознана: древовидный вид будет одноуровневым.",
    );
  }

  const customAliases = new Set(definitionAliases.values());
  const missingAliases = projectContext
    ? expectedCustomAliases.filter((alias) => !customAliases.has(alias))
    : [];
  if (missingAliases.length)
    warnings.push(
      `В схеме отсутствуют пользовательские поля: ${missingAliases.join(", ")}`,
    );
  const summaryTasks = sourceOperations.filter(
    (operation) => operation.operationType === "summary",
  ).length;
  const predecessorLinkCount = sourceOperations.reduce(
    (count, operation) => count + operation.predecessorLinks.length,
    0,
  );
  const projectMetadata = projectContext?.projectMetadata ?? {};
  const projectName =
    typeof projectMetadata.Name === "string" ? projectMetadata.Name : null;
  const projectRevision =
    typeof projectMetadata.Revision === "string"
      ? projectMetadata.Revision
      : null;
  const projectStatusDate =
    typeof projectMetadata.StatusDate === "string"
      ? projectMetadata.StatusDate
      : null;

  return ScheduleVersionSchema.parse({
    ...metadata,
    sourceFormat: "xml",
    rootElement,
    sourceNodeName: candidates[0].tagName,
    fieldNames: [...fieldNames],
    projectMetadata,
    customFieldDictionary: Object.fromEntries(definitionAliases),
    sourceOperations,
    indicatorMapping: {
      status: "partial",
      planned: { startField: null, finishField: null },
      forecast: { startField: null, finishField: null },
      actual: { startField: "ActualStart", finishField: "ActualFinish" },
      note:
        "Start/Finish сохраняются как исходные даты без назначения к плану или прогнозу. ActualStart/ActualFinish сопоставлены фактическим датам источника. Early/Late — расчётные поля, не бизнес-прогноз.",
    },
    workProjection: {
      status: "stub",
      identityParts: ["kfo", "building", "section", "floor"],
      note:
        "Преобразование исходных операций в работы SB_CDE не выполняется до утверждения правил неполной пространственной детализации и агрегации.",
    },
    validationReport: {
      parserVersion: "2.1.0",
      sourceFileName: metadata.originalFileName,
      sourceSha256: metadata.sourceSha256,
      projectName,
      projectRevision,
      projectStatusDate,
      taskCountXml: candidates.length,
      taskCountExported: sourceOperations.length,
      summaryTasks,
      nonSummaryTasks: sourceOperations.length - summaryTasks,
      maxOutlineLevel: Math.max(
        0,
        ...sourceOperations.map((operation) => operation.outlineLevel ?? 0),
      ),
      withCbsCode: sourceOperations.filter((operation) => operation.cbsCode)
        .length,
      withKfoCode: sourceOperations.filter((operation) => operation.kfoCode)
        .length,
      withVolumePlan: sourceOperations.filter(
        (operation) => operation.volumePlan !== null,
      ).length,
      withVolumeFact: sourceOperations.filter(
        (operation) => operation.volumeFact !== null,
      ).length,
      withActualStart: sourceOperations.filter(
        (operation) => operation.actualStart !== null,
      ).length,
      withActualFinish: sourceOperations.filter(
        (operation) => operation.actualFinish !== null,
      ).length,
      predecessorLinks: predecessorLinkCount,
      missingAliases,
      errors,
      warnings,
    },
    warnings,
  });
}

async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, file);
}

type VersionDescriptor = Pick<
  ScheduleVersion,
  | "id"
  | "label"
  | "kind"
  | "baselineSequence"
  | "operationalSequence"
  | "basedOnBaselineVersionId"
>;

export function nextVersionDescriptor(
  versions: ScheduleVersion[],
  kind: ScheduleVersionKind,
): VersionDescriptor {
  if (kind === "unclassified") {
    return {
      id: `version-${randomUUID()}`,
      label: "Не классифицирован",
      kind,
      baselineSequence: null,
      operationalSequence: null,
      basedOnBaselineVersionId: null,
    };
  }
  const baselineSequence = Math.max(
    0,
    ...versions.map((version) => version.baselineSequence ?? 0),
  );
  if (kind === "baseline") {
    const nextBaseline = baselineSequence + 1;
    return {
      id: `version-${randomUUID()}`,
      label: `Б${nextBaseline}`,
      kind,
      baselineSequence: nextBaseline,
      operationalSequence: null,
      basedOnBaselineVersionId: null,
    };
  }
  const baseline = [...versions]
    .filter((version) => version.kind === "baseline")
    .sort(
      (a, b) => (b.baselineSequence ?? 0) - (a.baselineSequence ?? 0),
    )[0];
  if (!baseline || baseline.baselineSequence === null) {
    throw new Error(
      "Операционную версию нельзя создать без базовой версии графика",
    );
  }
  const nextOperational =
    Math.max(
      0,
      ...versions
        .filter(
          (version) =>
            version.kind === "operational" &&
            version.baselineSequence === baseline.baselineSequence,
        )
        .map((version) => version.operationalSequence ?? 0),
    ) + 1;
  return {
    id: `version-${randomUUID()}`,
    label: `О${baseline.baselineSequence}.${nextOperational}`,
    kind,
    baselineSequence: baseline.baselineSequence,
    operationalSequence: nextOperational,
    basedOnBaselineVersionId: baseline.id,
  };
}

function assertXmlExtension(originalFileName: string) {
  const extension = path.extname(originalFileName).toLocaleLowerCase();
  if (extension !== supportedExtension)
    throw new Error("Поддерживаются только файлы .xml");
  return extension;
}

async function createVersionFromBuffer(
  scheduleId: string,
  versions: ScheduleVersion[],
  buffer: Buffer,
  originalFileName: string,
  kind: ScheduleVersionKind,
) {
  assertXmlExtension(originalFileName);
  const descriptor = nextVersionDescriptor(versions, kind);
  const versionDirectory = path.join(
    schedulesDir,
    scheduleId,
    "versions",
    descriptor.id,
  );
  await mkdir(versionDirectory, { recursive: true });
  const sourceFile = path.join(versionDirectory, "source.xml");
  const sourcePath = path.posix.join(
    "data",
    "schedules",
    scheduleId,
    "versions",
    descriptor.id,
    "source.xml",
  );
  const createdAt = new Date().toISOString();
  const version = parseScheduleXml(buffer, {
    ...descriptor,
    originalFileName: path.basename(originalFileName),
    sourcePath,
    sourceSha256: createHash("sha256").update(buffer).digest("hex"),
    sourceSize: buffer.byteLength,
    createdAt,
  });
  await writeFile(`${sourceFile}.tmp`, buffer);
  await rename(`${sourceFile}.tmp`, sourceFile);
  return version;
}

export async function createScheduleFromBuffer(
  buffer: Buffer,
  originalFileName: string,
  requestedName?: string,
  kind: ScheduleVersionKind = "baseline",
) {
  const extension = assertXmlExtension(originalFileName);
  const id = `schedule-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const version = await createVersionFromBuffer(
    id,
    [],
    buffer,
    originalFileName,
    kind,
  );
  const schedule = ProjectScheduleSchema.parse({
    schemaVersion: 5,
    id,
    name: requestedName?.trim() || path.basename(originalFileName, extension),
    versions: [version],
    createdAt,
    updatedAt: createdAt,
  });
  await atomicJson(path.join(schedulesDir, id, "schedule.json"), schedule);
  return schedule;
}

export async function addScheduleVersionFromBuffer(
  scheduleId: string,
  buffer: Buffer,
  originalFileName: string,
  kind: Exclude<ScheduleVersionKind, "unclassified">,
) {
  const schedule = await getSchedule(scheduleId);
  if (!schedule) throw new Error("График не найден");
  const version = await createVersionFromBuffer(
    schedule.id,
    schedule.versions,
    buffer,
    originalFileName,
    kind,
  );
  const updated = ProjectScheduleSchema.parse({
    ...schedule,
    versions: [...schedule.versions, version],
    updatedAt: version.createdAt,
  });
  await atomicJson(
    path.join(schedulesDir, schedule.id, "schedule.json"),
    updated,
  );
  return updated;
}

function sourceFileInsideSchedule(scheduleFile: string, sourcePath: unknown) {
  const directory = path.dirname(scheduleFile);
  const resolved = path.resolve(String(sourcePath ?? ""));
  const normalizedDirectory = directory.toLocaleLowerCase();
  const normalizedResolved = resolved.toLocaleLowerCase();
  if (
    normalizedResolved !== normalizedDirectory &&
    !normalizedResolved.startsWith(`${normalizedDirectory}${path.sep}`)
  ) {
    throw new Error("Путь исходного XML выходит за каталог графика");
  }
  return resolved;
}

async function migrateSchedule(
  value: unknown,
  scheduleFile: string,
): Promise<ProjectSchedule> {
  if (!value || typeof value !== "object")
    throw new Error("Некорректный файл графика");
  const legacy = value as Record<string, unknown>;
  if (legacy.schemaVersion === 5)
    return ProjectScheduleSchema.parse(value);

  const id = String(legacy.id ?? "");
  const createdAt = String(legacy.createdAt ?? new Date().toISOString());
  const rawVersions =
    (legacy.schemaVersion === 2 ||
      legacy.schemaVersion === 3 ||
      legacy.schemaVersion === 4) &&
    Array.isArray(legacy.versions)
      ? legacy.versions
      : Array.isArray(legacy.activities)
        ? [
            {
              id: `${id}-legacy-v1`,
              label: "Не классифицирован",
              kind: "unclassified",
              baselineSequence: null,
              operationalSequence: null,
              basedOnBaselineVersionId: null,
              originalFileName: legacy.originalFileName,
              sourcePath: legacy.sourcePath,
              createdAt,
            },
          ]
        : [];
  if (!rawVersions.length)
    throw new Error("В старом файле графика нет версий для миграции");

  const versions: ScheduleVersion[] = [];
  for (const item of rawVersions) {
    const raw = item as Record<string, unknown>;
    const sourceFile =
      legacy.schemaVersion === 1
        ? path.join(path.dirname(scheduleFile), "source.xml")
        : sourceFileInsideSchedule(scheduleFile, raw.sourcePath);
    const buffer = await readFile(sourceFile);
    versions.push(
      parseScheduleXml(buffer, {
        id: String(raw.id),
        label: String(raw.label),
        kind: ScheduleVersionKindSchema.parse(raw.kind),
        baselineSequence:
          typeof raw.baselineSequence === "number"
            ? raw.baselineSequence
            : null,
        operationalSequence:
          typeof raw.operationalSequence === "number"
            ? raw.operationalSequence
            : null,
        basedOnBaselineVersionId:
          typeof raw.basedOnBaselineVersionId === "string"
            ? raw.basedOnBaselineVersionId
            : null,
        originalFileName: String(raw.originalFileName),
        sourcePath: String(raw.sourcePath),
        sourceSha256: createHash("sha256").update(buffer).digest("hex"),
        sourceSize: buffer.byteLength,
        createdAt: String(raw.createdAt ?? createdAt),
      }),
    );
  }

  return ProjectScheduleSchema.parse({
    schemaVersion: 5,
    id,
    name: legacy.name,
    versions,
    createdAt,
    updatedAt: String(legacy.updatedAt ?? createdAt),
  });
}

async function readScheduleFile(file: string) {
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  const schedule = await migrateSchedule(raw, file);
  if ((raw as { schemaVersion?: unknown }).schemaVersion !== 5)
    await atomicJson(file, schedule);
  return schedule;
}

export function toScheduleSummary(
  schedule: ProjectSchedule,
): ProjectScheduleSummary {
  const latest = schedule.versions.at(-1);
  if (!latest) throw new Error("У графика нет версий");
  return {
    id: schedule.id,
    name: schedule.name,
    versionCount: schedule.versions.length,
    latestVersionId: latest.id,
    latestVersionLabel: latest.label,
    latestVersionKind: latest.kind,
    sourceOperationCount: latest.sourceOperations.length,
    projectRevision: latest.validationReport.projectRevision,
    validationErrorCount: latest.validationReport.errors.length,
    validationWarningCount: latest.validationReport.warnings.length,
    originalFileName: latest.originalFileName,
    sourceSha256s: schedule.versions.map((version) => version.sourceSha256),
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

const operationKey = (operation: SourceScheduleOperation) =>
  String(operation.uid ?? operation.id);

function operationParentKey(operation: SourceScheduleOperation) {
  const value = operation.parentUid ?? operation.parentId;
  if (value === null || value === undefined) return null;
  const key = String(value).trim();
  return key || null;
}

function ancestorsOf(
  operation: SourceScheduleOperation,
  byKey: Map<string, SourceScheduleOperation>,
) {
  const ancestors: Array<{
    id: string;
    uid: string | null;
    name: string;
    outlineLevel: number | null;
    outlineNumber: string | null;
  }> = [];
  const seen = new Set([operationKey(operation)]);
  let parentKey = operationParentKey(operation);
  while (parentKey && !seen.has(parentKey)) {
    seen.add(parentKey);
    const parent = byKey.get(parentKey);
    if (!parent) break;
    ancestors.unshift({
      id: parent.id,
      uid: parent.uid,
      name: parent.name,
      outlineLevel: parent.outlineLevel,
      outlineNumber: parent.outlineNumber,
    });
    parentKey = operationParentKey(parent);
  }
  return ancestors;
}

function scheduleVersion(schedule: ProjectSchedule, versionId: string) {
  return schedule.versions.find((version) => version.id === versionId) ?? null;
}

export function toScheduleManifest(schedule: ProjectSchedule) {
  return ProjectScheduleManifestSchema.parse({
    ...schedule,
    versions: schedule.versions.map((version) => {
      const { sourceOperations, ...metadata } = version;
      return {
        ...metadata,
        activityCount: sourceOperations.filter(
          (operation) => operation.operationType === "activity",
        ).length,
        milestoneCount: sourceOperations.filter(
          (operation) => operation.operationType === "milestone",
        ).length,
      };
    }),
  });
}

export function toScheduleTreeRows(
  schedule: ProjectSchedule,
  versionId: string,
) {
  const version = scheduleVersion(schedule, versionId);
  if (!version) return null;
  return version.sourceOperations.map((operation) =>
    ScheduleOperationRowSchema.parse(operation),
  );
}

export function queryScheduleOperations(
  schedule: ProjectSchedule,
  versionId: string,
  options: { query?: string; offset?: number; limit?: number } = {},
) {
  const version = scheduleVersion(schedule, versionId);
  if (!version) return null;
  const query = (options.query ?? "").trim().toLocaleLowerCase("ru");
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const limit = Math.min(250, Math.max(1, Math.trunc(options.limit ?? 100)));
  const byKey = new Map(
    version.sourceOperations.map((operation) => [
      operationKey(operation),
      operation,
    ]),
  );
  const matches = version.sourceOperations.filter((operation) => {
    if (operation.operationType !== "activity") return false;
    if (!query) return true;
    const ancestors = ancestorsOf(operation, byKey);
    return [
      operation.name,
      operation.id,
      operation.uid,
      operation.sourceId,
      operation.spiderCode,
      operation.wbsCode,
      operation.kfoCode,
      operation.cbsCode,
      operation.sourceStatus,
      ...ancestors.map((ancestor) => ancestor.name),
    ].some((value) =>
      String(value ?? "")
        .toLocaleLowerCase("ru")
        .includes(query),
    );
  });
  return ScheduleOperationsPageSchema.parse({
    items: matches.slice(offset, offset + limit).map((operation) => ({
      ...ScheduleOperationRowSchema.parse(operation),
      ancestors: ancestorsOf(operation, byKey),
    })),
    total: matches.length,
    offset,
    limit,
  });
}

export function toScheduleOperationDetail(
  schedule: ProjectSchedule,
  versionId: string,
  operationId: string,
) {
  const version = scheduleVersion(schedule, versionId);
  if (!version) return null;
  const operation =
    version.sourceOperations.find((item) => item.id === operationId) ?? null;
  if (!operation) return null;
  const byKey = new Map(
    version.sourceOperations.map((item) => [operationKey(item), item]),
  );
  return ScheduleOperationDetailSchema.parse({
    ...operation,
    ancestors: ancestorsOf(operation, byKey),
  });
}

export async function listSchedules() {
  await mkdir(schedulesDir, { recursive: true });
  const entries = await readdir(schedulesDir, { withFileTypes: true });
  const schedules: ProjectScheduleSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      schedules.push(
        toScheduleSummary(
          await readScheduleFile(
            path.join(schedulesDir, entry.name, "schedule.json"),
          ),
        ),
      );
    } catch {
      // Incomplete or obsolete imports are intentionally absent from the catalogue.
    }
  }
  return schedules.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteSchedule(id: string) {
  if (!/^schedule-[0-9a-f-]+$/i.test(id)) return false;
  const target = path.resolve(schedulesDir, id);
  if (!target.startsWith(`${schedulesDir}${path.sep}`)) return false;
  try {
    await rm(target, { recursive: true, force: false });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function getSchedule(id: string) {
  if (!/^schedule-[0-9a-f-]+$/i.test(id)) return null;
  try {
    return await readScheduleFile(path.join(schedulesDir, id, "schedule.json"));
  } catch {
    return null;
  }
}

export async function getScheduleSourceXml(scheduleId: string, versionId: string) {
  const schedule = await getSchedule(scheduleId);
  if (!schedule) return null;
  const version = schedule.versions.find((item) => item.id === versionId);
  if (!version) return null;
  const scheduleFile = path.join(schedulesDir, scheduleId, "schedule.json");
  const sourceFile = sourceFileInsideSchedule(scheduleFile, version.sourcePath);
  if (!sourceFile) return null;
  return { fileName: version.originalFileName, buffer: await readFile(sourceFile) };
}

export async function importScheduleInbox() {
  await mkdir(scheduleInboxDir, { recursive: true });
  const files = (
    await readdir(scheduleInboxDir, { withFileTypes: true })
  ).filter(
    (entry) =>
      entry.isFile() &&
      path.extname(entry.name).toLocaleLowerCase() === supportedExtension,
  );
  const knownHashes = new Set(
    (await listSchedules()).flatMap((schedule) => schedule.sourceSha256s),
  );
  const imported: ProjectScheduleSummary[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const source = path.join(scheduleInboxDir, file.name);
      const buffer = await readFile(source);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      if (knownHashes.has(sha256)) {
        skipped.push(file.name);
        continue;
      }
      const schedule = await createScheduleFromBuffer(
        buffer,
        file.name,
        undefined,
        "unclassified",
      );
      knownHashes.add(sha256);
      imported.push(toScheduleSummary(schedule));
    } catch (error) {
      errors.push(
        `${file.name}: ${error instanceof Error ? error.message : "ошибка импорта"}`,
      );
    }
  }
  return { imported, skipped, errors };
}

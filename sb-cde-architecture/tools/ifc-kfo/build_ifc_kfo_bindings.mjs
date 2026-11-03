import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_IFC_PATH = "public/models/RD_KR_04-08.ifc";
const DEFAULT_SCHEDULE_PATH =
  "data/schedules/schedule-fe13c646-f17c-480e-ae09-d4bdccd477b9/schedule.json";
const DEFAULT_OUTPUT_PATH = "data/ifc-kfo/bindings.json";

const PRODUCT_CLASSES = new Set([
  "IFCWALL", "IFCSLAB", "IFCBEAM", "IFCCOLUMN",
  "IFCBUILDINGELEMENTPROXY",
]);

export const MONOLITHIC_KFO_CODES = new Set([
  "204.02.03.01",
  "204.02.03.02",
]);

const STATUS_RULES = {
  completed: "ActualFinish заполнен или PercentComplete >= 100",
  overdue: "работа не завершена, а SourceFinish раньше даты состояния XML",
  in_progress: "ActualStart заполнен или 0 < PercentComplete < 100",
  planned: "SourceStart позже даты состояния XML, фактическое начало отсутствует",
  not_started: "SourceStart наступил, но фактическое начало и процент выполнения отсутствуют",
  unknown: "нет привязанных операций XML или недостаточно дат",
};

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function decodeIfcString(value) {
  return value
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
      let result = "";
      for (let index = 0; index < hex.length; index += 4) {
        result += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
      }
      return result;
    })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/''/g, "'");
}

function splitStepArguments(source) {
  const result = [];
  let current = "";
  let depth = 0;
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'") {
      if (inString && source[index + 1] === "'") {
        current += "''";
        index += 1;
        continue;
      }
      inString = !inString;
      current += character;
      continue;
    }
    if (!inString) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (character === "," && depth === 0) {
        result.push(current.trim());
        current = "";
        continue;
      }
    }
    current += character;
  }
  result.push(current.trim());
  return result;
}

function stepReferences(value = "") {
  return [...value.matchAll(/#(\d+)/g)].map((match) => match[1]);
}

function stepString(value = "") {
  const normalized = value.trim();
  if (normalized === "$" || normalized === "*") return null;
  const match = normalized.match(/^'([\s\S]*)'$/);
  return match ? decodeIfcString(match[1]) : decodeIfcString(normalized);
}

function stepValue(value = "") {
  const normalized = value.trim();
  if (normalized === "$" || normalized === "*") return null;
  const wrapped = normalized.match(/^IFC[A-Z0-9_]+\(([\s\S]*)\)$/);
  return stepString(wrapped ? wrapped[1] : normalized);
}

function selectedProperty(properties, names) {
  for (const name of names) {
    const value = properties[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

export function parseIfc(ifcText) {
  const records = new Map();
  for (const line of ifcText.split(/\r?\n/)) {
    const match = line.match(/^#(\d+)=(IFC[A-Z0-9_]+)\((.*)\);$/);
    if (!match) continue;
    records.set(match[1], { type: match[2], arguments: splitStepArguments(match[3]) });
  }

  const propertyValues = new Map();
  const propertySets = new Map();
  const typePropertySets = new Map();
  const products = new Map();
  for (const [expressId, record] of records) {
    if (record.type === "IFCPROPERTYSINGLEVALUE") {
      propertyValues.set(expressId, [stepString(record.arguments[0]), stepValue(record.arguments[2])]);
    }
    if (record.type === "IFCPROPERTYSET") {
      propertySets.set(expressId, stepReferences(record.arguments[4]));
    }
    if (record.type.endsWith("TYPE") && record.arguments[5]) {
      typePropertySets.set(expressId, stepReferences(record.arguments[5]));
    }
    const hasGeometry = stepReferences(record.arguments[6]).length > 0;
    if (PRODUCT_CLASSES.has(record.type) && hasGeometry) {
      products.set(expressId, {
        expressId: Number(expressId), ifcClass: record.type,
        globalId: stepString(record.arguments[0]), name: stepString(record.arguments[2]),
        tag: stepString(record.arguments[7]), properties: {}, hostExpressId: null,
        spatialContainerName: null,
      });
    }
  }

  const typeByProduct = new Map();
  for (const record of records.values()) {
    if (record.type === "IFCRELDEFINESBYPROPERTIES") {
      const productIds = stepReferences(record.arguments[4]);
      const propertySetId = stepReferences(record.arguments[5])[0];
      for (const productId of productIds) {
        const product = products.get(productId);
        if (!product) continue;
        for (const propertyId of propertySets.get(propertySetId) ?? []) {
          const property = propertyValues.get(propertyId);
          if (property?.[0]) product.properties[property[0]] = property[1];
        }
      }
    }
    if (record.type === "IFCRELDEFINESBYTYPE") {
      const typeId = stepReferences(record.arguments[5])[0];
      for (const productId of stepReferences(record.arguments[4])) typeByProduct.set(productId, typeId);
    }
    if (record.type === "IFCRELCONTAINEDINSPATIALSTRUCTURE") {
      const containerId = stepReferences(record.arguments[5])[0];
      const container = records.get(containerId);
      const containerName = container ? stepString(container.arguments[2]) : null;
      for (const productId of stepReferences(record.arguments[4])) {
        const product = products.get(productId);
        if (product) product.spatialContainerName = containerName;
      }
    }
  }

  for (const [productId, typeId] of typeByProduct) {
    const product = products.get(productId);
    if (!product) continue;
    for (const propertySetId of typePropertySets.get(typeId) ?? []) {
      for (const propertyId of propertySets.get(propertySetId) ?? []) {
        const property = propertyValues.get(propertyId);
        if (property?.[0] && product.properties[property[0]] === undefined) {
          product.properties[property[0]] = property[1];
        }
      }
    }
  }
  return products;
}

function productText(product) {
  return [
    product.name,
    product.properties["О_Наименование"],
    product.properties["Имя семейства"],
    product.properties["Имя типа"],
    product.properties.Семейство,
    product.properties.Тип,
  ].filter(Boolean).join(" | ").toLocaleLowerCase("ru");
}

function classifyConstructionProduct(product) {
  const directKfoValue = selectedProperty(product.properties, [
    "Код КФО",
    "КФО.Код",
    "КФО код",
    "KFO Code",
    "KFO_CODE",
    "KFO",
  ]);
  const directKfoCode = String(directKfoValue ?? "").match(/\b\d{3}(?:\.\d{2})+\b/)?.[0];
  if (directKfoCode) {
    return {
      kfoCode: directKfoCode,
      confidence: "confirmed",
      reason: "КФО прочитан напрямую из атрибута IFC-элемента.",
    };
  }
  const elementName = String(product.properties["О_Наименование"] ?? "").toLocaleLowerCase("ru");
  const category = String(product.properties.Категория ?? "").toLocaleLowerCase("ru");
  const classifierCode = String(product.properties["Код по классификатору"] ?? "");
  const text = productText(product);
  if (text.includes("сэндвич 150") || text.includes("сэндвич-панел")) {
    return { kfoCode: "204.02.03.08", confidence: "derived_high",
      reason: "Тип модели совпадает с КФО «Сэндвич панели» в XML." };
  }
  if (text.includes("засыпка песком")) {
    return { kfoCode: "unknown", confidence: "unknown",
      reason: "Для «Засыпки песком» нет прямого КФО и точной XML-операции; семантическая гипотеза снята." };
  }
  if (text.includes("условная стена")) {
    return { kfoCode: "unknown", confidence: "unknown",
      reason: "Служебная условная геометрия не определяет строительную работу." };
  }
  if (text.includes("анкерная пластина")) {
    return { kfoCode: "unknown", confidence: "unknown",
      reason: "Недостаточно оснований связывать пластину с КФО металлоконструкций крепления котлована." };
  }
  if (elementName.includes("перепад плит")) {
    return { kfoCode: "204.02.03.02", confidence: "derived_high",
      reason: "О_Наименование указывает на перепад плиты; IFC-класс стены не используется как единственный критерий." };
  }
  if (elementName.includes("стена монолитная") ||
      elementName.includes("колонна монолитная") ||
      elementName.includes("колонна круглая")) {
    return { kfoCode: "204.02.03.01", confidence: "derived_high",
      reason: "О_Наименование явно соответствует стенам/колоннам КФО 204.02.03.01." };
  }
  if (elementName.includes("плита монолитная") || elementName.includes("капител")) {
    return { kfoCode: "204.02.03.02", confidence: "derived_high",
      reason: "О_Наименование явно соответствует плите или капители КФО 204.02.03.02." };
  }
  if (elementName.includes("балк") || category.includes("каркас несущий") ||
      classifierCode === "КР.09") {
    return { kfoCode: "unknown", confidence: "unknown",
      reason: "В XML нет подтверждённого КФО для балок; прежняя гипотеза о КФО плит снята." };
  }
  return { kfoCode: "unknown", confidence: "unknown",
    reason: "Смысловых IFC-атрибутов недостаточно для подтверждённого КФО." };
}

function canonicalBuilding(value) {
  if (!value) return "unknown";
  const match = String(value).match(/Корпус\s+([А-ЯA-Z])/i);
  return match ? `Корпус ${match[1].toLocaleUpperCase("ru")}` : String(value);
}

function canonicalFloor(value) {
  if (!value) return "unknown";
  const normalized = String(value).trim();
  const match = normalized.match(/-?\d+/);
  return match ? `Этаж ${Number(match[0])}` : normalized;
}

function canonicalSection(value) {
  if (!value) return "unknown";
  const normalized = String(value).trim();
  const match = normalized.match(/(?:секци(?:я|и)\s*)?([A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9._-]*)/i);
  return match ? `Секция ${match[1].toLocaleUpperCase("ru")}` : normalized;
}

function productLocation(product) {
  const properties = product.properties;
  const building = selectedProperty(properties, ["О_Здание", "Здание"]);
  const floor = selectedProperty(properties, ["О_Этаж", "Этаж"]);
  const section = selectedProperty(properties, [
    "О_Секция", "Секция", "Номер секции", "Building Section", "Section",
  ]);
  return {
    building: canonicalBuilding(building),
    section: canonicalSection(section),
    floor: canonicalFloor(floor ?? product.spatialContainerName),
  };
}

function hierarchyFor(operation, operationsByUid) {
  const hierarchy = [];
  const visited = new Set();
  let current = operation;
  while (current && !visited.has(current.uid)) {
    hierarchy.unshift(current);
    visited.add(current.uid);
    current = current.parentUid ? operationsByUid.get(current.parentUid) : null;
  }
  return hierarchy;
}

export function operationLocations(operation, operationsByUid) {
  const names = hierarchyFor(operation, operationsByUid).map((item) => item.name).filter(Boolean);
  const buildings = new Set();
  const sections = new Set();
  const floors = new Set();
  for (const name of names) {
    const buildingMatch = name.match(/Корпус\s+([А-ЯA-Z](?:\s*,\s*[А-ЯA-Z])*)/i);
    if (buildingMatch) {
      for (const letter of buildingMatch[1].split(",")) {
        buildings.add(`Корпус ${letter.trim().toLocaleUpperCase("ru")}`);
      }
    }
    for (const sectionMatch of name.matchAll(/секци(?:я|и)\s+([A-ZА-ЯЁ0-9._-]+)/gi)) {
      sections.add(canonicalSection(sectionMatch[1]));
    }
    if (/Подземная часть/i.test(name)) floors.add("Этаж -1");
    for (const floorMatch of name.matchAll(/(?:^|[^\d-])(-?\d+)\s*(?:этаж|этажа|этажи)/gi)) {
      floors.add(`Этаж ${Number(floorMatch[1])}`);
    }
  }
  return { buildings, sections, floors, hierarchyPath: names.join(" / ") };
}

function timestamp(value) {
  if (!value) return null;
  const result = Date.parse(value);
  return Number.isNaN(result) ? null : result;
}

export function calculateOperationStatus(operation, asOfDate) {
  const percent = operation.percentComplete;
  if (operation.actualFinish || (percent !== null && percent >= 100)) return "completed";
  const asOf = timestamp(asOfDate);
  const finish = timestamp(operation.sourceFinish);
  if (asOf !== null && finish !== null && finish < asOf) return "overdue";
  if (operation.actualStart || (percent !== null && percent > 0 && percent < 100)) return "in_progress";
  const start = timestamp(operation.sourceStart);
  if (asOf !== null && start !== null && start > asOf) return "planned";
  if (start !== null) return "not_started";
  return "unknown";
}

export function calculateWorkStatus(operationStatuses) {
  if (operationStatuses.length === 0) return "unknown";
  if (operationStatuses.every((status) => status === "completed")) return "completed";
  if (operationStatuses.includes("overdue")) return "overdue";
  if (operationStatuses.includes("in_progress") || operationStatuses.includes("completed")) return "in_progress";
  if (operationStatuses.every((status) => status === "planned")) return "planned";
  if (operationStatuses.includes("not_started")) return "not_started";
  return "unknown";
}

function earliest(values) {
  return values.filter(Boolean).sort()[0] ?? null;
}

function latest(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

function matchScheduleOperations(kfoCode, location, scheduleOperations) {
  if (kfoCode === "unknown") return { level: "none", operations: [] };
  const candidates = scheduleOperations.filter((item) => item.operation.kfoCode === kfoCode);
  if (candidates.length === 0) return { level: "none", operations: [] };
  let bestScore = -1;
  let matches = [];
  for (const candidate of candidates) {
    let score = 0;
    const { buildings, sections, floors } = candidate.location;
    if (location.building !== "unknown") {
      if (buildings.size > 0 && !buildings.has(location.building)) continue;
      if (buildings.has(location.building)) score += 2;
    }
    if (location.section !== "unknown") {
      if (sections.size > 0 && !sections.has(location.section)) continue;
      if (sections.has(location.section)) score += 2;
    }
    if (location.floor !== "unknown") {
      if (floors.size > 0 && !floors.has(location.floor)) continue;
      if (floors.has(location.floor)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      matches = [candidate];
    } else if (score === bestScore) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) return { level: "none", operations: [] };
  const level = bestScore >= 6 ? "building_section_floor"
    : bestScore >= 4 ? "two_location_dimensions"
      : bestScore >= 2 ? "one_location_dimension"
        : "kfo_only";
  return { level, operations: matches };
}

function slug(value) {
  return String(value).toLocaleLowerCase("ru")
    .replace(/[^a-zа-яё0-9]+/gi, "-").replace(/^-|-$/g, "") || "unknown";
}

function compareText(left, right) {
  return left.localeCompare(right, "ru", { numeric: true });
}

function buildWork(kfoCode, kfoName, location, elements, scheduleOperations, asOfDate) {
  const scheduleMatch = matchScheduleOperations(kfoCode, location, scheduleOperations);
  const operations = scheduleMatch.operations.map(({ operation, location: operationLocation }) => {
    const status = calculateOperationStatus(operation, asOfDate);
    return {
      uid: operation.uid,
      sourceId: operation.sourceId,
      spiderCode: operation.spiderCode,
      name: operation.name,
      hierarchyPath: operationLocation.hierarchyPath,
      matchedLocation: {
        buildings: [...operationLocation.buildings].sort(compareText),
        sections: [...operationLocation.sections].sort(compareText),
        floors: [...operationLocation.floors].sort(compareText),
      },
      sourceStart: operation.sourceStart,
      sourceFinish: operation.sourceFinish,
      actualStart: operation.actualStart,
      actualFinish: operation.actualFinish,
      volumePlan: operation.volumePlan,
      volumeFact: operation.volumeFact,
      volumeCost: operation.volumeCost,
      percentComplete: operation.percentComplete,
      status,
    };
  });
  const numericPercents = operations.map((operation) => operation.percentComplete)
    .filter((value) => typeof value === "number");
  return {
    id: ["WORK", kfoCode.replaceAll(".", "_"), slug(location.building),
      slug(location.section), slug(location.floor)].join("__"),
    kfoCode,
    kfoName,
    location,
    scheduleMatchLevel: scheduleMatch.level,
    status: calculateWorkStatus(operations.map((operation) => operation.status)),
    statusAsOf: asOfDate,
    dates: {
      sourceStart: earliest(operations.map((operation) => operation.sourceStart)),
      sourceFinish: latest(operations.map((operation) => operation.sourceFinish)),
      actualStart: earliest(operations.map((operation) => operation.actualStart)),
      actualFinish: latest(operations.map((operation) => operation.actualFinish)),
    },
    progress: {
      minimum: numericPercents.length > 0 ? Math.min(...numericPercents) : null,
      maximum: numericPercents.length > 0 ? Math.max(...numericPercents) : null,
      averageUnweighted: numericPercents.length > 0
        ? Number((numericPercents.reduce((sum, value) => sum + value, 0) / numericPercents.length).toFixed(2))
        : null,
    },
    operations,
    elementCount: elements.length,
    elements,
  };
}

function flattenKfoHierarchy(works) {
  const kfoMap = new Map();
  for (const work of works) {
    const kfo = kfoMap.get(work.kfoCode) ?? {
      code: work.kfoCode, name: work.kfoName, elementCount: 0, buildings: new Map(),
    };
    kfo.elementCount += work.elementCount;
    const building = kfo.buildings.get(work.location.building) ?? {
      name: work.location.building, elementCount: 0, sections: new Map(),
    };
    building.elementCount += work.elementCount;
    const section = building.sections.get(work.location.section) ?? {
      name: work.location.section, elementCount: 0, floors: [],
    };
    section.elementCount += work.elementCount;
    section.floors.push({ name: work.location.floor, elementCount: work.elementCount, work });
    building.sections.set(work.location.section, section);
    kfo.buildings.set(work.location.building, building);
    kfoMap.set(work.kfoCode, kfo);
  }
  const kfos = [...kfoMap.values()].map((kfo) => ({
    code: kfo.code,
    name: kfo.name,
    elementCount: kfo.elementCount,
    buildings: [...kfo.buildings.values()].sort((a, b) => compareText(a.name, b.name)).map((building) => ({
      name: building.name,
      elementCount: building.elementCount,
      sections: [...building.sections.values()].sort((a, b) => compareText(a.name, b.name)).map((section) => ({
        name: section.name,
        elementCount: section.elementCount,
        floors: section.floors.sort((a, b) => compareText(a.name, b.name)),
      })),
    })),
  }));
  return kfos.sort((a, b) => compareText(a.code, b.code));
}

export function buildBindings({ ifcText, ifcBuffer, schedule, ifcPath, schedulePath }) {
  const products = parseIfc(ifcText);
  const excludedOpeningCount = [...ifcText.matchAll(/^#\d+=IFCOPENINGELEMENT\(/gm)].length;
  const version = schedule.versions[0];
  if (!version) throw new Error("В графике нет версии для сопоставления.");
  const asOfDate = version.validationReport?.projectStatusDate ??
    version.projectMetadata?.StatusDate ?? null;
  if (!asOfDate) throw new Error("В XML не найдена дата состояния проекта.");

  const classified = new Map();
  for (const [expressId, product] of products) {
    classified.set(expressId, classifyConstructionProduct(product));
  }
  const modelKfoCodes = new Set(
    [...classified.values()]
      .map((classification) => classification.kfoCode)
      .filter((kfoCode) => kfoCode !== "unknown"),
  );
  const operationsByUid = new Map(version.sourceOperations.map((operation) => [operation.uid, operation]));
  const sourceOperationsWithKfo = version.sourceOperations.filter((operation) => operation.kfoCode);
  const scheduleOperations = sourceOperationsWithKfo
    .filter((operation) =>
      modelKfoCodes.has(operation.kfoCode) &&
      MONOLITHIC_KFO_CODES.has(operation.kfoCode))
    .map((operation) => ({ operation, location: operationLocations(operation, operationsByUid) }));
  const kfoNames = new Map();
  for (const operation of sourceOperationsWithKfo) {
    if (modelKfoCodes.has(operation.kfoCode) && operation.kfoName) {
      kfoNames.set(operation.kfoCode, operation.kfoName);
    }
  }

  const grouped = new Map();
  for (const [expressId, product] of products) {
    const classification = classified.get(expressId);
    const location = productLocation(product);
    const key = [classification.kfoCode, location.building, location.section, location.floor].join("\u0000");
    const group = grouped.get(key) ?? { kfoCode: classification.kfoCode, location, elements: [] };
    group.elements.push({
      id: product.globalId ?? `express-${product.expressId}`,
      globalId: product.globalId,
      expressId: product.expressId,
      tag: product.tag,
      ifcClass: product.ifcClass,
      name: product.name,
      hostGlobalId: null,
      hostExpressId: null,
      classificationConfidence: classification.confidence,
      classificationReason: classification.reason,
      attributes: {
        elementName: product.properties["О_Наименование"] ?? null,
        category: product.properties.Категория ?? null,
        family: selectedProperty(product.properties, ["Имя семейства", "Семейство"]),
        type: selectedProperty(product.properties, ["Имя типа", "Тип"]),
        familyAndType: product.properties["Семейство и типоразмер"] ?? null,
        typeCode: product.properties["Код типа"] ?? null,
        reference: product.properties.Reference ?? null,
        building: location.building,
        section: location.section,
        floor: location.floor,
        material: product.properties["Мтрл.Название"] ??
          product.properties["О_Материал обозначение"] ?? null,
        classifierCode: product.properties["Код по классификатору"] ?? null,
        mark: selectedProperty(product.properties, ["О_Марка", "Марка"]),
        volume: product.properties.Объем ?? null,
        quantity: product.properties["О_Количество"] ?? null,
        units: product.properties["О_Единицы измерения"] ?? null,
        elevation: product.properties["О_Отметка"] ?? null,
        constructionStage: product.properties["Стадия возведения"] ?? null,
        spatialContainer: product.spatialContainerName ?? null,
      },
    });
    grouped.set(key, group);
  }

  const works = [...grouped.values()].map((group) => {
    group.elements.sort((a, b) => compareText(a.id, b.id));
    return buildWork(
      group.kfoCode,
      kfoNames.get(group.kfoCode) ?? (group.kfoCode === "unknown" ? "Не определён" : null),
      group.location,
      group.elements,
      scheduleOperations,
      asOfDate,
    );
  }).sort((a, b) => compareText(
    `${a.kfoCode}|${a.location.building}|${a.location.section}|${a.location.floor}`,
    `${b.kfoCode}|${b.location.building}|${b.location.section}|${b.location.floor}`,
  ));

  const kfos = flattenKfoHierarchy(works);
  const allElements = works.flatMap((work) => work.elements);
  const linkedScheduleOperations = new Set(
    works.flatMap((work) => work.operations.map((operation) => operation.uid)),
  );
  const confidenceCounts = allElements.reduce((counts, element) => {
    counts[element.classificationConfidence] = (counts[element.classificationConfidence] ?? 0) + 1;
    return counts;
  }, {});
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectId: "local-project",
    scheduleId: schedule.id,
    scheduleVersionId: version.id,
    scheduleVersionLabel: version.label,
    statusAsOf: asOfDate,
    statusCatalog: {
      path: "data/ifc-kfo/statuses.json",
      foreignKey: "work.status",
      primaryKey: "statuses[].id",
    },
    sources: {
      ifc: { path: ifcPath, sha256: sha256(ifcBuffer) },
      schedule: {
        path: schedulePath,
        sourceXmlPath: version.sourcePath,
        sourceXmlSha256: version.sourceSha256,
      },
    },
    statusRules: STATUS_RULES,
    spatialRules: {
      building: "О_Здание",
      section: "О_Секция/Секция; при отсутствии — unknown",
      floor: "О_Этаж; при отсутствии — IFC spatial container",
      scheduleScope: "Атрибуты корпуса, секции и этажа из XML-дерева используются только для монолитных КФО 204.02.03.01 и 204.02.03.02.",
      scheduleMatching: "Строгое сопоставление по КФО и всем доступным измерениям: корпус + секция + этаж. Пространственное несовпадение не откатывается к выборке всего КФО.",
    },
    operationSelection: {
      basis: "Только монолитные КФО 204.02.03.01 и 204.02.03.02, представленные геометрическими элементами IFC-модели",
      modelKfoCodes: [...modelKfoCodes].sort(compareText),
      sourceOperationCount: version.sourceOperations.length,
      sourceOperationsWithKfo: sourceOperationsWithKfo.length,
      modelKfoCandidateOperations: scheduleOperations.length,
      linkedScheduleOperations: linkedScheduleOperations.size,
    },
    summary: {
      elementCount: allElements.length,
      excludedOpeningCount,
      workCount: works.length,
      kfoCount: kfos.length,
      confidenceCounts,
      elementsWithUnknownKfo: works.filter((work) => work.kfoCode === "unknown")
        .reduce((count, work) => count + work.elementCount, 0),
      elementsWithUnknownSection: allElements.filter((element) => element.attributes.section === "unknown").length,
      linkedScheduleOperations: linkedScheduleOperations.size,
    },
    warnings: [
      "В IFC нет прямого параметра КФО: derived_high означает правило по атрибутам, а не исходный код модели.",
      "XML-операции предварительно ограничены КФО, представленными в IFC-модели; остальные операции графика в артефакт привязок не попадают.",
      "Корпус, секция и этаж из XML-дерева привязываются только к монолитным работам КФО 204.02.03.01 и 204.02.03.02.",
      "Балки не имеют подтверждённого КФО в XML, сохранены как unknown и не визуализируются.",
      "SourceStart/SourceFinish сохранены как исходные сроки XML и не названы планом или прогнозом.",
      "Секция в проверенной IFC-модели отсутствует и сохранена как unknown.",
      "IFCOPENINGELEMENT полностью исключены из результата.",
    ],
    kfos,
  };
}

function parseCliArguments(argumentsList) {
  const options = {
    ifcPath: DEFAULT_IFC_PATH,
    schedulePath: DEFAULT_SCHEDULE_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--ifc") options.ifcPath = argumentsList[++index];
    else if (argument === "--schedule") options.schedulePath = argumentsList[++index];
    else if (argument === "--output") options.outputPath = argumentsList[++index];
    else throw new Error(`Неизвестный аргумент: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  const ifcPath = resolve(options.ifcPath);
  const schedulePath = resolve(options.schedulePath);
  const outputPath = resolve(options.outputPath);
  const [ifcBuffer, scheduleBuffer] = await Promise.all([readFile(ifcPath), readFile(schedulePath)]);
  const result = buildBindings({
    ifcText: ifcBuffer.toString("utf8"),
    ifcBuffer,
    schedule: JSON.parse(scheduleBuffer.toString("utf8")),
    ifcPath: options.ifcPath.replaceAll("\\", "/"),
    schedulePath: options.schedulePath.replaceAll("\\", "/"),
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`Сохранено ${result.summary.elementCount} IFC-элементов в ${result.summary.workCount} работ: ${outputPath}`);
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();

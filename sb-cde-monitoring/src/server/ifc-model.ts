import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IfcElementBinding, IfcMappingStatus } from "../shared/monitoring.js";
import type { BimModelId } from "../shared/models.js";
import { DEFAULT_IDENTIFIERS, type IdentifierDefinition } from "../shared/identifiers.js";
import { readIdentifierSettings } from "./identifier-settings.js";

type StepRecord = { type: string; args: string[] };
type Product = {
  expressId: number;
  ifcClass: string;
  globalId: string | null;
  name: string | null;
  properties: Record<string, string | null>;
  spatialContainer: string | null;
};

const MODEL_CONFIG: Record<BimModelId, {
  sourcePath: string;
  cachePath: string;
  mapping: "legacy" | "parameters";
}> = {
  structural: {
    sourcePath: path.resolve("public/models/RD_KR_04-08.ifc"),
    cachePath: path.resolve("data/mappings/RD_KR_04-08.elements.cache.json"),
    mapping: "legacy",
  },
  full: {
    sourcePath: path.resolve("public/models/1816_PSK_RD_KR_M3_R24.ifc"),
    cachePath: path.resolve("data/mappings/1816_PSK_RD_KR_M3_R24.elements.cache.json"),
    mapping: "parameters",
  },
};
const PRODUCT_CLASSES = new Set(["IFCWALL", "IFCSLAB", "IFCBEAM", "IFCCOLUMN", "IFCBUILDINGELEMENTPROXY"]);
const KFO_NAMES: Record<string, string> = {
  "204.02.01.04": "Обратная засыпка с уплотнением",
  "204.02.02.02": "Железобетонные сваи",
  "204.02.02.05": "Монолитные конструкции ниже 0",
  "204.02.03.01": "Монолитные стены и колонны выше 0",
  "204.02.03.02": "Монолитные плиты и прочие конструкции выше 0",
  "204.02.03.05": "Второстепенные металлоконструкции",
};

function decodeIfc(value: string) {
  return value
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_match, hex: string) => {
      let result = "";
      for (let index = 0; index < hex.length; index += 4) {
        result += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
      }
      return result;
    })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/''/g, "'");
}

function splitArgs(source: string) {
  const result: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'") {
      if (quoted && source[index + 1] === "'") {
        current += "''";
        index += 1;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted) {
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

function refs(value = "") {
  return [...value.matchAll(/#(\d+)/g)].map((match) => match[1]);
}

function stringValue(value = ""): string | null {
  const normalized = value.trim();
  if (!normalized || normalized === "$" || normalized === "*") return null;
  const typed = normalized.match(/^IFC[A-Z0-9_]+\(([\s\S]*)\)$/);
  const source = typed ? typed[1] : normalized;
  const quoted = source.match(/^'([\s\S]*)'$/);
  return decodeIfc(quoted ? quoted[1] : source);
}

function canonicalBuilding(value: string | null) {
  const match = value?.match(/корпус\s+([А-ЯЁA-Z])/iu);
  return match ? `Корпус ${match[1].toLocaleUpperCase("ru")}` : value;
}

function canonicalFloor(value: string | null) {
  if (!value) return null;
  const match = value.match(/-?\d+/);
  return match ? `Этаж ${Number(match[0])}` : value.trim();
}

function selected(properties: Record<string, string | null>, names: string[]) {
  for (const name of names) {
    const value = properties[name];
    if (value) return value;
  }
  return null;
}

function normalizeMappingText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ru");
}

function attributePattern(pattern: string) {
  const escaped = normalizeMappingText(pattern)
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*");
  return new RegExp(`^${escaped}$`, "u");
}

function sourceValues(properties: Record<string, string | null>, definition: IdentifierDefinition) {
  const propertiesByName = Object.entries(properties).map(([name, value]) => [normalizeMappingText(name), value] as const);
  const values: string[] = [];
  for (const attribute of definition.attributes) {
    const matches = attributePattern(attribute);
    const found = propertiesByName.find(([name, value]) => Boolean(value) && matches.test(name));
    if (found?.[1]) values.push(found[1]);
  }
  return [...new Set(values)];
}

function mappedIdentifierValue(
  properties: Record<string, string | null>,
  definitions: IdentifierDefinition[],
  key: string,
) {
  const definition = definitions.find((item) => item.key === key);
  if (!definition) return null;
  for (const raw of sourceValues(properties, definition)) {
    const normalizedRaw = normalizeMappingText(raw);
    for (const value of definition.values) {
      const aliases = [value, ...(definition.valueAliases[value] ?? [])];
      if (aliases.some((alias) => normalizeMappingText(alias) === normalizedRaw)) return value;
    }
    if (key === "kfo") {
      const code = raw.match(/\d+(?:\.\d+)+/)?.[0];
      if (code && definition.values.includes(code)) return code;
    }
  }
  return null;
}

export function readIfcIdentityParameters(
  properties: Record<string, string | null>,
  definitions: IdentifierDefinition[] = DEFAULT_IDENTIFIERS,
) {
  return {
    kfoCode: mappedIdentifierValue(properties, definitions, "kfo"),
    building: mappedIdentifierValue(properties, definitions, "building"),
    section: mappedIdentifierValue(properties, definitions, "section"),
    floor: mappedIdentifierValue(properties, definitions, "floor"),
  };
}

const NON_PHYSICAL_PRODUCT_CLASSES = new Set([
  "IFCANNOTATION", "IFCGRID", "IFCOPENINGELEMENT", "IFCSPACE",
]);

function isPhysicalProduct(record: StepRecord) {
  const globalId = stringValue(record.args[0]);
  return record.type.startsWith("IFC")
    && !record.type.endsWith("TYPE")
    && !NON_PHYSICAL_PRODUCT_CLASSES.has(record.type)
    && globalId?.length === 22
    && refs(record.args[5]).length > 0
    && refs(record.args[6]).length > 0;
}

function elementKind(product: Product): IfcElementBinding["elementKind"] {
  if (product.ifcClass === "IFCWALL") return "walls";
  if (product.ifcClass === "IFCCOLUMN") return "columns";
  if (product.ifcClass === "IFCSLAB") return "slabs";
  if (product.ifcClass === "IFCBEAM") return "beams";
  const text = [product.name, ...Object.values(product.properties)].filter(Boolean).join(" | ").toLocaleLowerCase("ru");
  if (/стен/.test(text)) return "walls";
  if (/колонн/.test(text)) return "columns";
  if (/плит|капител|перепад|термовклад/.test(text)) return "slabs";
  if (/балк/.test(text)) return "beams";
  return "other";
}

function belongsToFirstFloorStructure(product: Product) {
  const text = [product.name, ...Object.values(product.properties)]
    .filter(Boolean).join(" | ").toLocaleLowerCase("ru");
  return /плит|перекрыт|капител|нескаркас_балка|каркас\s+несущ|structural framing/.test(text);
}

function classify(product: Product, floor: string | null) {
  const family = selected(product.properties, ["Имя семейства", "Семейство"]);
  const text = [product.name, family, selected(product.properties, ["Категория", "Тип", "Имя типа"])]
    .filter(Boolean).join(" | ").toLocaleLowerCase("ru");
  const kind = elementKind(product);
  if (text.includes("кж3_засыпка песком") || text.includes("засыпка песком")) {
    return { code: "204.02.01.04", status: "review" as IfcMappingStatus, reason: "Гипотеза по семейству «КЖ3_Засыпка песком»; требуется проверка специалистом." };
  }
  if (text.includes("пластина для анкеровки")) {
    return { code: "204.02.03.05", status: "review" as IfcMappingStatus, reason: "Гипотеза по семейству «Пластина для анкеровки»; требуется проверка специалистом." };
  }
  const inferredStatus: IfcMappingStatus = product.ifcClass === "IFCBUILDINGELEMENTPROXY" ? "review" : "rule_based";
  if (floor === "Этаж -1") {
    return { code: "204.02.02.05", status: inferredStatus, reason: "Назначено по исходному О_Этаж = Этаж -1 и классу несущей конструкции." };
  }
  if (floor === "Этаж 1" && (kind === "walls" || kind === "columns")) {
    return { code: "204.02.03.01", status: inferredStatus, reason: "Назначено по О_Этаж = Этаж 1 и классу стены/колонны." };
  }
  if (floor === "Этаж 1" && (kind === "slabs" || kind === "beams" || product.ifcClass === "IFCBUILDINGELEMENTPROXY")) {
    return { code: "204.02.03.02", status: inferredStatus, reason: "Назначено по О_Этаж = Этаж 1 и классу балки/плиты/прокси." };
  }
  return { code: null, status: "unmapped" as IfcMappingStatus, reason: "Правило текущей модели не определило КФО." };
}

function parseProducts(ifc: string) {
  const records = new Map<string, StepRecord>();
  for (const line of ifc.split(/\r?\n/)) {
    const match = line.match(/^#(\d+)=(IFC[A-Z0-9_]+)\((.*)\);$/);
    if (match) records.set(match[1], { type: match[2], args: splitArgs(match[3]) });
  }

  const propertyValues = new Map<string, [string | null, string | null]>();
  const propertySets = new Map<string, string[]>();
  const typePropertySets = new Map<string, string[]>();
  const products = new Map<string, Product>();
  for (const [id, record] of records) {
    if (record.type === "IFCPROPERTYSINGLEVALUE") {
      propertyValues.set(id, [stringValue(record.args[0]), stringValue(record.args[2])]);
    }
    if (record.type === "IFCPROPERTYSET") propertySets.set(id, refs(record.args[4]));
    if (record.type.endsWith("TYPE")) typePropertySets.set(id, refs(record.args[5]));
    if (isPhysicalProduct(record)) {
      products.set(id, {
        expressId: Number(id),
        ifcClass: record.type,
        globalId: stringValue(record.args[0]),
        name: stringValue(record.args[2]),
        properties: {},
        spatialContainer: null,
      });
    }
  }

  const typeByProduct = new Map<string, string>();
  for (const record of records.values()) {
    if (record.type === "IFCRELDEFINESBYPROPERTIES") {
      const propertySetId = refs(record.args[5])[0];
      for (const productId of refs(record.args[4])) {
        const product = products.get(productId);
        if (!product) continue;
        for (const propertyId of propertySets.get(propertySetId) ?? []) {
          const [name, value] = propertyValues.get(propertyId) ?? [null, null];
          if (name) product.properties[name] = value;
        }
      }
    }
    if (record.type === "IFCRELDEFINESBYTYPE") {
      const typeId = refs(record.args[5])[0];
      for (const productId of refs(record.args[4])) typeByProduct.set(productId, typeId);
    }
    if (record.type === "IFCRELCONTAINEDINSPATIALSTRUCTURE") {
      const container = records.get(refs(record.args[5])[0]);
      const containerName = container ? stringValue(container.args[2]) : null;
      for (const productId of refs(record.args[4])) {
        const product = products.get(productId);
        if (product) product.spatialContainer = containerName;
      }
    }
  }
  for (const [productId, typeId] of typeByProduct) {
    const product = products.get(productId);
    if (!product) continue;
    for (const propertySetId of typePropertySets.get(typeId) ?? []) {
      for (const propertyId of propertySets.get(propertySetId) ?? []) {
        const [name, value] = propertyValues.get(propertyId) ?? [null, null];
        if (name && product.properties[name] === undefined) product.properties[name] = value;
      }
    }
  }
  return [...products.values()];
}

const cache = new Map<BimModelId, Promise<IfcElementBinding[]>>();

async function loadIfcElements(modelId: BimModelId) {
  const config = MODEL_CONFIG[modelId];
  const sourceStat = await stat(config.sourcePath);
  const settings = await readIdentifierSettings();
  try {
    const stored = JSON.parse(await readFile(config.cachePath, "utf8")) as {
      schemaVersion?: number;
      sourceSize?: number;
      sourceMtimeMs?: number;
      settingsRevision?: string;
      elements?: IfcElementBinding[];
    };
    if (
      stored.schemaVersion === 9
      && stored.sourceSize === sourceStat.size
      && stored.sourceMtimeMs === sourceStat.mtimeMs
      && stored.settingsRevision === settings.revision
      && Array.isArray(stored.elements)
      && stored.elements.every((element) => Number.isInteger(element.expressId))
    ) {
      return stored.elements;
    }
  } catch {
    // Missing, outdated or malformed cache: rebuild it from the IFC source.
  }

  const ifc = await readFile(config.sourcePath, "utf8");
  const products = parseProducts(ifc).filter((product) =>
    config.mapping === "parameters" || PRODUCT_CLASSES.has(product.ifcClass));
  const elements = products.flatMap((product) => {
    const allText = [product.name, ...Object.values(product.properties)].filter(Boolean).join(" | ").toLocaleLowerCase("ru");
    if (product.ifcClass === "IFCCOLUMN" && allText.includes("для подрезки балки")) return [];
    if (config.mapping === "parameters") {
      const identity = readIfcIdentityParameters(product.properties, settings.identifiers);
      const { kfoCode, building, section } = identity;
      const sourceFloor = identity.floor ?? canonicalFloor(product.spatialContainer);
      const floor = belongsToFirstFloorStructure(product) ? "Этаж 1" : sourceFloor;
      const missing = [
        !kfoCode && "КФО",
        !building && "корпус",
        !section && "секция",
        !floor && "этаж",
      ].filter(Boolean);
      return [{
        expressId: product.expressId,
        globalId: product.globalId,
        ifcClass: product.ifcClass,
        name: product.name,
        kfoCode,
        kfoName: kfoCode ? KFO_NAMES[kfoCode] ?? null : null,
        kfoStatus: kfoCode ? "rule_based" : "unmapped",
        mappingReason: missing.length
          ? `По настройкам идентификаторов из IFC не прочитаны: ${missing.join(", ")}.`
          : "КФО, корпус, секция и этаж прочитаны по настройкам идентификаторов.",
        building,
        section,
        floor,
        elementKind: elementKind(product),
        workId: null,
        workMappingReason: "Связь с работой ещё не рассчитана.",
      } satisfies IfcElementBinding];
    }
    const identity = readIfcIdentityParameters(product.properties, settings.identifiers);
    const building = identity.building ?? canonicalBuilding(selected(product.properties, ["О_Здание", "Здание"]));
    const sourceFloor = identity.floor ?? canonicalFloor(selected(product.properties, ["О_Этаж", "Этаж"]) ?? product.spatialContainer);
    const floor = belongsToFirstFloorStructure(product) ? "Этаж 1" : sourceFloor;
    const fallbackClassification = classify(product, floor);
    const classification = identity.kfoCode
      ? { code: identity.kfoCode, status: "rule_based" as IfcMappingStatus, reason: "КФО прочитан по настройкам идентификаторов." }
      : fallbackClassification;
    return [{
      expressId: product.expressId,
      globalId: product.globalId,
      ifcClass: product.ifcClass,
      name: product.name,
      kfoCode: classification.code,
      kfoName: classification.code ? KFO_NAMES[classification.code] ?? null : null,
      kfoStatus: classification.status,
      mappingReason: classification.reason,
      building,
      section: identity.section,
      floor,
      elementKind: elementKind(product),
      workId: null,
      workMappingReason: "Связь с работой ещё не рассчитана.",
    } satisfies IfcElementBinding];
  });
  await mkdir(path.dirname(config.cachePath), { recursive: true });
  const temporary = `${config.cachePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({
    schemaVersion: 9,
    sourceSize: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    settingsRevision: settings.revision,
    elements,
  }), "utf8");
  await rename(temporary, config.cachePath);
  return elements;
}

export function getBimModelPath(modelId: BimModelId) {
  return MODEL_CONFIG[modelId].sourcePath;
}

export function readIfcElements(modelId: BimModelId = "structural") {
  let elements = cache.get(modelId);
  if (!elements) {
    elements = loadIfcElements(modelId);
    cache.set(modelId, elements);
  }
  return elements;
}

export function invalidateIfcElementCache() {
  cache.clear();
}

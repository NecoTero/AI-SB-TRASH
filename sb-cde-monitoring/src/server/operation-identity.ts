import type { SourceOperation } from "../shared/schedule.js";

export type BaselineMatchStrategy = "semantic" | "name_kfo" | "name" | "source_id" | "uid" | "spider_code";
export type BaselineMatch = { operation: SourceOperation; strategy: BaselineMatchStrategy };

function normalized(value: string | null | undefined) {
  return (value ?? "").normalize("NFKC").toLocaleLowerCase("ru")
    .replace(/\s+\/\s+[a-z][\s\S]*$/iu, "")
    .replace(/[^\p{L}\p{N}.-]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}

function constructionContext(operation: SourceOperation) {
  const path = normalized(operation.location.sourcePath.join(" / "));
  if (/лестнично лифт/.test(path)) return "stairs";
  if (/плит|перекрыт|капител/.test(path)) return "slabs";
  if (/колонн/.test(path)) return "columns";
  if (/(?:^| )стен(?:а|ы| )/.test(path)) return "walls";
  if (/балк|ригел/.test(path)) return "beams";
  return "general";
}

export function operationSemanticKey(operation: SourceOperation) {
  return [
    normalized(operation.name),
    normalized(operation.kfoCode),
    normalized(operation.location.building),
    normalized(operation.location.section),
    normalized(operation.location.floor),
    constructionContext(operation),
  ].join("|");
}

function operationNameKfoKey(operation: SourceOperation) {
  return [normalized(operation.name), normalized(operation.kfoCode)].join("|");
}

function operationNameKey(operation: SourceOperation) {
  return normalized(operation.name);
}

function uniqueIndex(operations: SourceOperation[], key: (operation: SourceOperation) => string | null) {
  const buckets = new Map<string, SourceOperation[]>();
  for (const operation of operations) {
    const value = key(operation);
    if (!value) continue;
    const bucket = buckets.get(value);
    if (bucket) bucket.push(operation);
    else buckets.set(value, [operation]);
  }
  return new Map([...buckets].flatMap(([value, items]) => items.length === 1 ? [[value, items[0]] as const] : []));
}

export function createBaselineMatcher(
  baseline: SourceOperation[],
  current: SourceOperation[],
  allowIdentifierMatch: boolean,
) {
  const baselineSemantic = uniqueIndex(baseline, operationSemanticKey);
  const currentSemantic = uniqueIndex(current, operationSemanticKey);
  const baselineNameKfo = uniqueIndex(baseline, operationNameKfoKey);
  const currentNameKfo = uniqueIndex(current, operationNameKfoKey);
  const baselineName = uniqueIndex(baseline, operationNameKey);
  const currentName = uniqueIndex(current, operationNameKey);
  const baselineBySourceId = uniqueIndex(baseline, (operation) => operation.sourceId);
  const baselineByUid = uniqueIndex(baseline, (operation) => operation.uid);
  const baselineBySpider = uniqueIndex(baseline, (operation) => operation.spiderCode);

  return (operation: SourceOperation): BaselineMatch | null => {
    const semanticKey = operationSemanticKey(operation);
    const semantic = currentSemantic.get(semanticKey) === operation ? baselineSemantic.get(semanticKey) : null;
    if (semantic) return { operation: semantic, strategy: "semantic" };
    const nameKfoKey = operationNameKfoKey(operation);
    const nameKfo = currentNameKfo.get(nameKfoKey) === operation ? baselineNameKfo.get(nameKfoKey) : null;
    if (nameKfo) return { operation: nameKfo, strategy: "name_kfo" };
    const nameKey = operationNameKey(operation);
    const name = currentName.get(nameKey) === operation ? baselineName.get(nameKey) : null;
    if (name) return { operation: name, strategy: "name" };
    if (!allowIdentifierMatch) return null;
    const bySourceId = operation.sourceId ? baselineBySourceId.get(operation.sourceId) : null;
    if (bySourceId) return { operation: bySourceId, strategy: "source_id" };
    const byUid = operation.uid ? baselineByUid.get(operation.uid) : null;
    if (byUid) return { operation: byUid, strategy: "uid" };
    const bySpider = operation.spiderCode ? baselineBySpider.get(operation.spiderCode) : null;
    return bySpider ? { operation: bySpider, strategy: "spider_code" } : null;
  };
}

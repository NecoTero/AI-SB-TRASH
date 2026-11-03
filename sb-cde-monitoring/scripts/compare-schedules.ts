import { readFile } from "node:fs/promises";
import { inspectScheduleXml } from "../src/server/xml-parser.js";
import type { SourceOperation } from "../src/shared/schedule.js";

function occurrences(operations: SourceOperation[], value: (operation: SourceOperation) => string | null) {
  const counts = new Map<string, number>();
  for (const operation of operations) {
    const key = value(operation);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function uniqueIndex(operations: SourceOperation[], value: (operation: SourceOperation) => string | null) {
  const counts = occurrences(operations, value);
  return new Map(operations.flatMap((operation) => {
    const key = value(operation);
    return key && counts.get(key) === 1 ? [[key, operation] as const] : [];
  }));
}

function hierarchyNames(operations: SourceOperation[]) {
  const levels = new Map<number, Map<string, number>>();
  for (const operation of operations) {
    const cmrIndex = operation.location.sourcePath.findIndex((item) => item.trim().toLocaleLowerCase("ru") === "смр");
    const parents = operation.location.sourcePath.slice(cmrIndex + 1, -1);
    parents.forEach((name, level) => {
      const names = levels.get(level) ?? new Map<string, number>();
      names.set(name, (names.get(name) ?? 0) + 1);
      levels.set(level, names);
    });
  }
  return Object.fromEntries([...levels].map(([level, names]) => [
    String(level + 1),
    [...names].sort((left, right) => right[1] - left[1]).slice(0, 30).map(([name, operationCount]) => ({ name, operationCount })),
  ]));
}

function duplicates(operations: SourceOperation[], value: (operation: SourceOperation) => string | null) {
  return [...occurrences(operations, value)].filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1]).slice(0, 30)
    .map(([value, count]) => ({ value, count }));
}

function describe(label: string, operations: SourceOperation[]) {
  return {
    label,
    operationCount: operations.length,
    withoutKfo: operations.filter((operation) => !operation.kfoCode).length,
    withoutBuilding: operations.filter((operation) => !operation.location.building).length,
    withoutSection: operations.filter((operation) => !operation.location.section).length,
    withoutFloor: operations.filter((operation) => !operation.location.floor).length,
    kfoCodes: [...new Set(operations.flatMap((operation) => operation.kfoCode ? [operation.kfoCode] : []))].sort(),
    duplicateSourceIds: duplicates(operations, (operation) => operation.sourceId),
    duplicateUids: duplicates(operations, (operation) => operation.uid),
    duplicateSpiderCodes: duplicates(operations, (operation) => operation.spiderCode),
    identityCoverage: {
      sourceId: operations.filter((operation) => operation.sourceId).length,
      uid: operations.filter((operation) => operation.uid).length,
      spiderCode: operations.filter((operation) => operation.spiderCode).length,
    },
    bimCandidates: operations.filter((operation) =>
      ["204.02.03.01", "204.02.03.02"].includes(operation.kfoCode ?? "")
      && ["Корпус Б", "Корпус В"].includes(operation.location.building ?? "")
      && operation.location.floor === "Этаж 1"
    ).map((operation) => ({
      sourceId: operation.sourceId,
      uid: operation.uid,
      name: operation.name,
      kfoCode: operation.kfoCode,
      building: operation.location.building,
      floor: operation.location.floor,
      path: operation.location.sourcePath.join(" / "),
    })),
    hierarchyNames: hierarchyNames(operations),
  };
}

function comparison(baseline: SourceOperation[], next: SourceOperation[]) {
  const baselineById = uniqueIndex(baseline, (operation) => operation.sourceId);
  const nextById = uniqueIndex(next, (operation) => operation.sourceId);
  const baselineByUid = uniqueIndex(baseline, (operation) => operation.uid);
  const nextByUid = uniqueIndex(next, (operation) => operation.uid);
  const baselineBySpider = uniqueIndex(baseline, (operation) => operation.spiderCode);
  const nextBySpider = uniqueIndex(next, (operation) => operation.spiderCode);
  const intersections = (left: Map<string, SourceOperation>, right: Map<string, SourceOperation>) =>
    [...left.keys()].filter((key) => right.has(key));
  const sourceIdMatches = intersections(baselineById, nextById);
  const changes = sourceIdMatches.flatMap((key) => {
    const before = baselineById.get(key)!;
    const after = nextById.get(key)!;
    const changed = {
      sourceId: key,
      uid: [before.uid, after.uid],
      name: [before.name, after.name],
      kfoCode: [before.kfoCode, after.kfoCode],
      building: [before.location.building, after.location.building],
      section: [before.location.section, after.location.section],
      floor: [before.location.floor, after.location.floor],
      dates: [`${before.start ?? "—"} — ${before.finish ?? "—"}`, `${after.start ?? "—"} — ${after.finish ?? "—"}`],
      path: [before.location.sourcePath.join(" / "), after.location.sourcePath.join(" / ")],
    };
    return Object.values(changed).some((value) => Array.isArray(value) && value[0] !== value[1]) ? [changed] : [];
  });
  return {
    uniqueMatches: {
      sourceId: sourceIdMatches.length,
      uid: intersections(baselineByUid, nextByUid).length,
      spiderCode: intersections(baselineBySpider, nextBySpider).length,
    },
    baselineOnlySourceIds: [...baselineById.keys()].filter((key) => !nextById.has(key)).slice(0, 100),
    nextOnlySourceIds: [...nextById.keys()].filter((key) => !baselineById.has(key)).slice(0, 100),
    changedMatchedOperations: changes.length,
    changedExamples: changes.slice(0, 50),
  };
}

const [baselinePath, nextPath] = process.argv.slice(2);
if (!baselinePath || !nextPath) throw new Error("Usage: compare-schedules <baseline.xml> <next.xml>");
const [baselineBuffer, nextBuffer] = await Promise.all([readFile(baselinePath), readFile(nextPath)]);
const baseline = inspectScheduleXml(baselineBuffer);
const next = inspectScheduleXml(nextBuffer);
console.log(JSON.stringify({
  baseline: { statusDate: baseline.sourceStatusDate, ...describe("baseline", baseline.operations) },
  next: { statusDate: next.sourceStatusDate, ...describe("next", next.operations) },
  comparison: comparison(baseline.operations, next.operations),
}, null, 2));

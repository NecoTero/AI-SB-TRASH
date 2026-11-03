import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ProjectScheduleSchema,
  ScheduleSnapshotSchema,
  type ProjectSchedule,
  type ScheduleSnapshot,
} from "../shared/schedule.js";
import { deriveOperationLocation } from "../shared/location.js";

const ROOT = path.resolve("data/schedules");
const INDEX = path.join(ROOT, "index.json");
const snapshotCache = new Map<string, Promise<ScheduleSnapshot>>();

async function atomicJson(target: string, value: unknown) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function readIndex(): Promise<ProjectSchedule[]> {
  try {
    const value = JSON.parse(await readFile(INDEX, "utf8"));
    return ProjectScheduleSchema.array().parse(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function listSchedules() {
  return readIndex();
}

export async function getSchedule(id: string) {
  return (await readIndex()).find((schedule) => schedule.id === id) ?? null;
}

export async function saveImportedVersion(args: {
  scheduleId?: string;
  scheduleName: string;
  xml: Buffer;
  snapshot: ScheduleSnapshot;
}) {
  const schedules = await readIndex();
  const now = args.snapshot.version.importedAt;
  let schedule = args.scheduleId ? schedules.find((item) => item.id === args.scheduleId) : undefined;
  if (args.scheduleId && !schedule) throw new Error("Выбранный график не найден.");
  if (!schedule) {
    schedule = {
      schemaVersion: 1,
      id: args.snapshot.scheduleId,
      name: args.scheduleName,
      versions: [],
      createdAt: now,
      updatedAt: now,
    };
    schedules.push(schedule);
  }
  if (schedule.versions.some((version) => version.id === args.snapshot.version.id)) {
    throw new Error("Версия с таким идентификатором уже существует.");
  }
  const versionDirectory = path.join(ROOT, schedule.id, "versions", args.snapshot.version.id);
  await mkdir(versionDirectory, { recursive: true });
  await writeFile(path.join(versionDirectory, "source.xml"), args.xml);
  await atomicJson(path.join(versionDirectory, "snapshot.json"), args.snapshot);
  snapshotCache.set(path.join(versionDirectory, "snapshot.json"), Promise.resolve(args.snapshot));
  schedule.versions.push(args.snapshot.version);
  schedule.updatedAt = now;
  await atomicJson(INDEX, schedules);
  return schedule;
}

function readStoredSnapshot(value: unknown): ScheduleSnapshot {
  if (!value || typeof value !== "object") throw new Error("Файл снимка графика повреждён.");
  const snapshot = value as Partial<ScheduleSnapshot>;
  if (
    snapshot.schemaVersion !== 1
    || typeof snapshot.scheduleId !== "string"
    || !snapshot.version
    || !snapshot.projectMetadata
    || typeof snapshot.projectMetadata !== "object"
    || !Array.isArray(snapshot.operations)
    || !Array.isArray(snapshot.hierarchy)
    || !Array.isArray(snapshot.calendars)
    || !snapshot.customFieldDefinitions
    || typeof snapshot.customFieldDefinitions !== "object"
    || Array.isArray(snapshot.customFieldDefinitions)
  ) {
    throw new Error("Файл снимка графика имеет неподдерживаемую структуру.");
  }
  return snapshot as ScheduleSnapshot;
}

async function loadSnapshot(scheduleId: string, versionId: string) {
  const target = path.join(ROOT, scheduleId, "versions", versionId, "snapshot.json");
  const snapshot = readStoredSnapshot(JSON.parse(await readFile(target, "utf8")));
  const upgraded: ScheduleSnapshot = {
    ...snapshot,
    operations: snapshot.operations.map((operation) => ({
      ...operation,
      location: deriveOperationLocation(operation.location.sourcePath, operation.location),
    })),
  };
  const locationWasBackfilled = upgraded.operations.some((operation, index) =>
    JSON.stringify(operation.location) !== JSON.stringify(snapshot.operations[index].location),
  );
  if (locationWasBackfilled) await atomicJson(target, upgraded);
  return upgraded;
}

export async function getSnapshot(scheduleId: string, versionId: string) {
  const target = path.join(ROOT, scheduleId, "versions", versionId, "snapshot.json");
  let snapshot = snapshotCache.get(target);
  if (!snapshot) {
    snapshot = loadSnapshot(scheduleId, versionId);
    snapshotCache.set(target, snapshot);
  }
  try {
    return await snapshot;
  } catch (error) {
    snapshotCache.delete(target);
    throw error;
  }
}

export async function getSourceXml(scheduleId: string, versionId: string) {
  return readFile(path.join(ROOT, scheduleId, "versions", versionId, "source.xml"));
}

export async function updateScheduleVersionStatusDate(
  scheduleId: string,
  versionId: string,
  effectiveStatusDate: string,
) {
  const schedules = await readIndex();
  const schedule = schedules.find((item) => item.id === scheduleId);
  if (!schedule) throw new Error("График не найден.");
  const versionIndex = schedule.versions.findIndex((item) => item.id === versionId);
  if (versionIndex < 0) throw new Error("Версия графика не найдена.");

  const sourceVersion = schedule.versions[versionIndex];
  const version = {
    ...sourceVersion,
    effectiveStatusDate,
    statusDateWasOverridden: effectiveStatusDate !== sourceVersion.sourceStatusDate?.slice(0, 10),
  };
  const snapshotPath = path.join(ROOT, scheduleId, "versions", versionId, "snapshot.json");
  const sourceSnapshot = await getSnapshot(scheduleId, versionId);
  const snapshot = ScheduleSnapshotSchema.parse({ ...sourceSnapshot, version });

  await atomicJson(snapshotPath, snapshot);
  snapshotCache.set(snapshotPath, Promise.resolve(snapshot));
  schedule.versions[versionIndex] = version;
  schedule.updatedAt = new Date().toISOString();
  try {
    await atomicJson(INDEX, schedules);
  } catch (error) {
    await atomicJson(snapshotPath, sourceSnapshot);
    snapshotCache.set(snapshotPath, Promise.resolve(sourceSnapshot));
    throw error;
  }
  return { schedule, version };
}

export function versionDeletionBlocker(schedule: ProjectSchedule, versionId: string) {
  const version = schedule.versions.find((item) => item.id === versionId);
  if (!version) return "Версия графика не найдена.";
  if (version.kind === "baseline") {
    const dependentCount = schedule.versions.filter((item) => item.basedOnBaselineVersionId === versionId).length;
    if (dependentCount) return `Сначала удалите связанные операционные версии (${dependentCount}).`;
  }
  return null;
}

export async function deleteScheduleVersion(scheduleId: string, versionId: string) {
  const schedules = await readIndex();
  const scheduleIndex = schedules.findIndex((item) => item.id === scheduleId);
  if (scheduleIndex < 0) throw new Error("График не найден.");
  const schedule = schedules[scheduleIndex];
  const blocker = versionDeletionBlocker(schedule, versionId);
  if (blocker) throw new Error(blocker);

  const versionsRoot = path.resolve(ROOT, schedule.id, "versions");
  const versionDirectory = path.resolve(versionsRoot, versionId);
  if (!versionDirectory.startsWith(`${versionsRoot}${path.sep}`)) throw new Error("Некорректный путь версии.");
  const temporaryDirectory = `${versionDirectory}.deleting-${randomUUID()}`;
  await rename(versionDirectory, temporaryDirectory);
  const deletedVersion = schedule.versions.find((item) => item.id === versionId)!;
  schedule.versions = schedule.versions.filter((item) => item.id !== versionId);
  schedule.updatedAt = new Date().toISOString();
  if (!schedule.versions.length) schedules.splice(scheduleIndex, 1);
  try {
    await atomicJson(INDEX, schedules);
  } catch (error) {
    await rename(temporaryDirectory, versionDirectory);
    throw error;
  }
  snapshotCache.delete(path.join(versionDirectory, "snapshot.json"));
  await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  return {
    deletedVersion,
    schedule: schedule.versions.length ? schedule : null,
  };
}

export function nextVersionLabel(
  schedule: ProjectSchedule | null,
  kind: "baseline" | "operational",
  baselineId: string | null,
) {
  if (kind === "baseline") {
    const sequence = Math.max(0, ...(schedule?.versions
      .filter((version) => version.kind === "baseline")
      .map((version) => Number(version.label.match(/^Б(\d+)$/u)?.[1] ?? 0)) ?? [])) + 1;
    return `Б${sequence}`;
  }
  if (!schedule || !baselineId) throw new Error("Для операционной версии нужно выбрать базовую.");
  const baseline = schedule.versions.find((version) => version.id === baselineId && version.kind === "baseline");
  if (!baseline) throw new Error("Выбранная базовая версия не принадлежит графику.");
  const baselineNumber = Number(baseline.label.match(/^Б(\d+)$/u)?.[1]);
  if (!baselineNumber) throw new Error("У базовой версии повреждён технический номер.");
  const sequence = Math.max(0, ...schedule.versions
    .filter((version) => version.kind === "operational" && version.basedOnBaselineVersionId === baselineId)
    .map((version) => Number(version.label.match(/^О\d+\.(\d+)$/u)?.[1] ?? 0))) + 1;
  return `О${baselineNumber}.${sequence}`;
}


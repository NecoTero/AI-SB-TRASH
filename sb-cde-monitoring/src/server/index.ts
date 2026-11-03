import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { MAX_SCHEDULE_OPERATIONS, ScheduleSnapshotSchema, type ScheduleTreeRow } from "../shared/schedule.js";
import { createVersionMetadata, inspectScheduleXml } from "./xml-parser.js";
import {
  deleteScheduleVersion, getSchedule, getSnapshot, listSchedules, nextVersionLabel, saveImportedVersion,
  updateScheduleVersionStatusDate,
} from "./repository.js";
import {
  buildModelWorks, buildMonitoringSnapshot, buildMonitoringStatusPatch, invalidateMonitoringCaches,
} from "./monitoring.js";
import { BIM_MODELS, isBimModelId } from "../shared/models.js";
import { getBimModelPath, invalidateIfcElementCache } from "./ifc-model.js";
import { ensureViewerGeometry } from "./viewer-geometry.js";
import { readIdentifierSettings, saveIdentifierSettings } from "./identifier-settings.js";

const app = Fastify({ logger: true, bodyLimit: 60 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

app.get("/api/health", async () => ({ ok: true }));
app.get("/api/schedules", async () => listSchedules());
app.get("/api/models", async () => BIM_MODELS);
app.get("/api/settings/identifiers", async () => readIdentifierSettings());
app.put<{ Body: unknown }>("/api/settings/identifiers", async (request) => {
  const saved = await saveIdentifierSettings(request.body);
  invalidateIfcElementCache();
  invalidateMonitoringCaches();
  return saved;
});

app.get<{
  Params: { modelId: string };
}>("/api/models/:modelId/file", async (request, reply) => {
  if (!isBimModelId(request.params.modelId)) {
    return reply.code(404).send({ message: "BIM-модель не найдена." });
  }
  const model = BIM_MODELS.find((item) => item.id === request.params.modelId)!;
  reply.header("Content-Type", "application/x-step");
  reply.header("Content-Disposition", `inline; filename="${model.fileName}"`);
  return reply.send(createReadStream(getBimModelPath(request.params.modelId)));
});

app.get<{
  Params: { modelId: string };
}>("/api/models/:modelId/geometry", async (request, reply) => {
  if (!isBimModelId(request.params.modelId)) {
    return reply.code(404).send({ message: "BIM-модель не найдена." });
  }
  const geometry = await ensureViewerGeometry(request.params.modelId);
  reply.header("ETag", geometry.etag);
  reply.header("Cache-Control", "private, no-cache");
  if (request.headers["if-none-match"] === geometry.etag) return reply.code(304).send();
  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Length", String(geometry.size));
  reply.header("X-Viewer-Elements", String(geometry.elements));
  reply.header("X-Viewer-Placements", String(geometry.placements));
  reply.header("X-Viewer-Triangles", String(geometry.triangles));
  return reply.send(createReadStream(geometry.filePath));
});

app.delete<{
  Params: { scheduleId: string; versionId: string };
}>("/api/schedules/:scheduleId/versions/:versionId", async (request) => {
  const result = await deleteScheduleVersion(request.params.scheduleId, request.params.versionId);
  invalidateMonitoringCaches();
  return result;
});

app.get<{
  Params: { scheduleId: string; versionId: string };
  Querystring: { date?: string; compact?: string; modelId?: string };
}>("/api/schedules/:scheduleId/versions/:versionId/monitoring", async (request, reply) => {
  const date = request.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return reply.code(400).send({ message: "Укажите выбранную дату в формате YYYY-MM-DD." });
  }
  const modelId = request.query.modelId ?? "structural";
  if (!isBimModelId(modelId)) {
    return reply.code(400).send({ message: "Выбрана неизвестная BIM-модель." });
  }
  return request.query.compact === "1"
    ? buildMonitoringStatusPatch(request.params.scheduleId, request.params.versionId, date, modelId)
    : buildMonitoringSnapshot(request.params.scheduleId, request.params.versionId, date, modelId);
});

app.get<{
  Params: { scheduleId: string; versionId: string };
  Querystring: { offset?: string; limit?: string; kfo?: string };
}>("/api/schedules/:scheduleId/versions/:versionId/operations", async (request) => {
  const snapshot = await getSnapshot(request.params.scheduleId, request.params.versionId);
  const offset = Math.max(0, Number(request.query.offset ?? 0));
  const limit = Math.min(MAX_SCHEDULE_OPERATIONS, Math.max(1, Number(request.query.limit ?? 100)));
  const kfo = request.query.kfo;
  const filtered = kfo === undefined
    ? snapshot.operations
    : snapshot.operations.filter((operation) => (operation.kfoCode ?? "none кфо") === kfo);
  return { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit };
});

app.get<{
  Params: { scheduleId: string; versionId: string };
}>("/api/schedules/:scheduleId/versions/:versionId/model-works", async (request) =>
  buildModelWorks(request.params.scheduleId, request.params.versionId));

app.get<{
  Params: { scheduleId: string; versionId: string };
}>("/api/schedules/:scheduleId/versions/:versionId/tree", async (request) => {
  const snapshot = await getSnapshot(request.params.scheduleId, request.params.versionId);
  const rootIndex = snapshot.hierarchy.findIndex((item) => item.name?.toLocaleLowerCase("ru") === "смр");
  if (rootIndex < 0) return { items: [] };
  const rootLevel = snapshot.hierarchy[rootIndex].outlineLevel ?? 0;
  let endIndex = snapshot.hierarchy.length;
  for (let index = rootIndex + 1; index < snapshot.hierarchy.length; index += 1) {
    const level = snapshot.hierarchy[index].outlineLevel;
    if (level !== null && level <= rootLevel) { endIndex = index; break; }
  }
  const operations = new Map(snapshot.operations.map((item) => [item.sourceOrder, item]));
  const items: ScheduleTreeRow[] = snapshot.hierarchy.slice(rootIndex, endIndex).map((item) => {
    const operation = operations.get(item.sourceOrder);
    return {
      rowId: operation?.snapshotOperationId ?? `summary:${item.sourceOrder}:${item.uid ?? "no-uid"}`,
      sourceOrder: item.sourceOrder,
      name: item.name ?? "Без названия",
      outlineNumber: item.outlineNumber ?? operation?.outlineNumber ?? null,
      outlineLevel: item.outlineLevel ?? operation?.outlineLevel ?? rootLevel,
      isSummary: item.summary !== "0",
      isMilestone: operation?.isMilestone ?? false,
      start: item.start ?? operation?.start ?? null,
      finish: item.finish ?? operation?.finish ?? null,
      actualStart: item.actualStart ?? operation?.actualStart ?? null,
      actualFinish: item.actualFinish ?? operation?.actualFinish ?? null,
      percentComplete: item.percentComplete ?? operation?.percentComplete ?? null,
    };
  });
  return { items };
});

app.post("/api/schedules/import", async (request, reply) => {
  const fields = new Map<string, string>();
  let xml: Buffer | null = null;
  let fileName = "schedule.xml";
  for await (const part of request.parts()) {
    if (part.type === "file") {
      fileName = part.filename;
      xml = await part.toBuffer();
    } else {
      fields.set(part.fieldname, String(part.value));
    }
  }
  if (!xml) return reply.code(400).send({ message: "Выберите XML-файл." });
  if (!fileName.toLocaleLowerCase("ru").endsWith(".xml")) {
    return reply.code(400).send({ message: "Поддерживается только XML." });
  }

  const scheduleIdInput = fields.get("scheduleId") || undefined;
  const schedule = scheduleIdInput ? await getSchedule(scheduleIdInput) : null;
  const kindInput = fields.get("kind");
  const kind = kindInput === "baseline" || kindInput === "operational"
    ? kindInput
    : schedule ? "operational" : "baseline";
  if (!schedule && kind !== "baseline") {
    return reply.code(400).send({ message: "Первой версией может быть только базовый график." });
  }
  const baselineId = fields.get("basedOnBaselineVersionId") || null;
  const effectiveStatusDate = fields.get("effectiveStatusDate")?.trim();
  if (!effectiveStatusDate || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveStatusDate)) {
    return reply.code(400).send({ message: "Укажите отчётную дату." });
  }
  const scheduleId = schedule?.id ?? randomUUID();
  const inspection = inspectScheduleXml(xml);
  if (inspection.operations.length > MAX_SCHEDULE_OPERATIONS) {
    return reply.code(422).send({
      message: `В графике ${inspection.operations.length.toLocaleString("ru-RU")} операций. Лимит системы — ${MAX_SCHEDULE_OPERATIONS.toLocaleString("ru-RU")}. Импорт остановлен.`,
    });
  }
  const importedAt = new Date().toISOString();
  const version = createVersionMetadata({
    id: randomUUID(),
    label: nextVersionLabel(schedule, kind, baselineId),
    kind,
    basedOnBaselineVersionId: kind === "operational" ? baselineId : null,
    originalFileName: fileName,
    sourceSize: xml.length,
    importedAt,
    effectiveStatusDate,
    inspection,
  });
  const snapshot = ScheduleSnapshotSchema.parse({
    schemaVersion: 1,
    scheduleId,
    version,
    projectMetadata: inspection.projectMetadata,
    customFieldDefinitions: inspection.definitions,
    hierarchy: inspection.hierarchy,
    calendars: inspection.calendars,
    operations: inspection.operations,
  });
  const saved = await saveImportedVersion({
    scheduleId: schedule?.id,
    scheduleName: fields.get("scheduleName")?.trim() || schedule?.name || fileName.replace(/\.xml$/i, ""),
    xml,
    snapshot,
  });
  return reply.code(201).send({ schedule: saved, version });
});

app.patch<{
  Params: { scheduleId: string; versionId: string };
  Body: { effectiveStatusDate?: string };
}>("/api/schedules/:scheduleId/versions/:versionId/status-date", async (request, reply) => {
  const effectiveStatusDate = request.body?.effectiveStatusDate;
  if (!effectiveStatusDate || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveStatusDate)) {
    return reply.code(400).send({ message: "Укажите отчётную дату." });
  }
  const updated = await updateScheduleVersionStatusDate(
    request.params.scheduleId,
    request.params.versionId,
    effectiveStatusDate,
  );
  invalidateMonitoringCaches();
  return updated;
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  void reply.code(400).send({ message });
});

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3011);
await app.listen({ host: "127.0.0.1", port });


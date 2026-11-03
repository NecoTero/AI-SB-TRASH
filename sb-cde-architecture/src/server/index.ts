import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyReply } from "fastify";
import multipart from "@fastify/multipart";
import { TaskDraftSchema, TaskSchema } from "../shared/model.js";
import { readProject, writeProject } from "./repository.js";
import { readIfcKfoBindings, readIfcStatusCatalog } from "./ifc-kfo.js";
import {
  addScheduleVersionFromBuffer,
  createScheduleFromBuffer,
  deleteSchedule,
  getSchedule,
  getScheduleSourceXml,
  importScheduleInbox,
  listSchedules,
  scheduleInboxDir,
} from "./schedules.js";

const app = Fastify({ logger: false });
await app.register(multipart, {
  limits: {
    files: 1,
    fields: 4,
    parts: 5,
    fileSize: 25 * 1024 * 1024,
  },
});
const distDir = path.resolve("dist");
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

async function sendStaticFile(file: string, reply: FastifyReply) {
  try {
    const details = await stat(file);
    if (!details.isFile()) return false;
    reply.type(
      contentTypes[path.extname(file).toLowerCase()] ??
        "application/octet-stream",
    );
    if (file.includes(`${path.sep}assets${path.sep}`))
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
    else reply.header("Cache-Control", "no-cache");
    reply.send(createReadStream(file));
    return true;
  } catch {
    return false;
  }
}

app.get("/api/health", async () => ({ ok: true }));
app.get("/api/project", async () => readProject());
app.get("/api/current-map", async () => (await readProject()).currentMap);
app.get("/api/tasks", async () => (await readProject()).tasks);
app.get("/api/ifc-kfo/statuses", async () => readIfcStatusCatalog());
app.get("/api/ifc-kfo/bindings", async () => readIfcKfoBindings());
app.get("/api/tasks/:taskId", async (request, reply) => {
  const project = await readProject();
  const taskId = (request.params as { taskId: string }).taskId;
  const task = project.tasks.find((item) => item.taskId === taskId);
  if (!task) return reply.code(404).send({ error: "Task not found" });
  return {
    task,
    draft: project.drafts.find((item) => item.taskId === taskId) ?? null,
  };
});
app.put("/api/tasks/:taskId", async (request) => {
  const taskId = (request.params as { taskId: string }).taskId;
  const task = TaskSchema.parse({ ...(request.body as object), taskId });
  const project = await readProject();
  await writeProject({
    ...project,
    tasks: [...project.tasks.filter((item) => item.taskId !== taskId), task],
  });
  return task;
});
app.put("/api/tasks/:taskId/draft", async (request) => {
  const taskId = (request.params as { taskId: string }).taskId;
  const draft = TaskDraftSchema.parse({ ...(request.body as object), taskId });
  const project = await readProject();
  await writeProject({
    ...project,
    drafts: [...project.drafts.filter((item) => item.taskId !== taskId), draft],
  });
  return draft;
});
app.get("/api/schedules", async () => listSchedules());
app.delete("/api/schedules/:scheduleId", async (request, reply) => {
  const scheduleId = (request.params as { scheduleId: string }).scheduleId;
  const deleted = await deleteSchedule(scheduleId);
  if (!deleted) return reply.code(404).send({ error: "График не найден" });
  return reply.code(204).send();
});app.get("/api/schedules/:scheduleId", async (request, reply) => {
  const scheduleId = (request.params as { scheduleId: string }).scheduleId;
  const schedule = await getSchedule(scheduleId);
  if (!schedule) return reply.code(404).send({ error: "График не найден" });
  return schedule;
});
app.get("/api/schedules/:scheduleId/versions/:versionId/source.xml", async (request, reply) => {
  const params = request.params as { scheduleId: string; versionId: string };
  const source = await getScheduleSourceXml(params.scheduleId, params.versionId);
  if (!source) return reply.code(404).send({ error: "Исходный XML не найден" });
  return reply
    .type("application/xml; charset=utf-8")
    .header("Content-Disposition", `filename="${encodeURIComponent(source.fileName)}"`)
    .send(source.buffer);
});
app.post("/api/schedules", async (request, reply) => {
  try {
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: "Выберите файл .xml" });
    const buffer = await upload.toBuffer();
    const nameField = upload.fields.name as { value?: unknown } | undefined;
    const requestedName =
      typeof nameField?.value === "string" ? nameField.value : undefined;
    const schedule = await createScheduleFromBuffer(
      buffer,
      upload.filename,
      requestedName,
      "baseline",
    );
    return reply.code(201).send(schedule);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Не удалось импортировать график";
    const statusCode =
      typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode: unknown }).statusCode)
        : 400;
    return reply
      .code(
        Number.isInteger(statusCode) && statusCode >= 400 ? statusCode : 400,
      )
      .send({ error: message });
  }
});
app.post("/api/schedules/:scheduleId/versions", async (request, reply) => {
  try {
    const scheduleId = (request.params as { scheduleId: string }).scheduleId;
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: "Выберите файл .xml" });
    const buffer = await upload.toBuffer();
    const kindField = upload.fields.kind as { value?: unknown } | undefined;
    const kind = kindField?.value;
    if (kind !== "baseline" && kind !== "operational") {
      return reply
        .code(400)
        .send({ error: "Выберите базовую или операционную версию" });
    }
    const schedule = await addScheduleVersionFromBuffer(
      scheduleId,
      buffer,
      upload.filename,
      kind,
    );
    return reply.code(201).send(schedule);
  } catch (error) {
    return reply.code(400).send({
      error:
        error instanceof Error
          ? error.message
          : "Не удалось добавить версию графика",
    });
  }
});
app.post("/api/schedules/import-inbox", async () => ({
  inbox: scheduleInboxDir,
  ...(await importScheduleInbox()),
}));

app.get("/", async (_request, reply) => {
  if (await sendStaticFile(path.join(distDir, "index.html"), reply))
    return reply;
  return reply
    .code(404)
    .send({ error: "Frontend build not found. Run npm run build." });
});
app.get("/*", async (request, reply) => {
  const requestedPath = (request.params as { "*": string })["*"];
  const file = path.resolve(distDir, requestedPath);
  const isInsideDist =
    file === distDir || file.startsWith(`${distDir}${path.sep}`);
  if (!isInsideDist) return reply.code(403).send({ error: "Forbidden path" });
  if (requestedPath && (await sendStaticFile(file, reply))) return reply;
  if (path.extname(requestedPath))
    return reply.code(404).send({ error: "Asset not found" });
  if (await sendStaticFile(path.join(distDir, "index.html"), reply))
    return reply;
  return reply
    .code(404)
    .send({ error: "Frontend build not found. Run npm run build." });
});

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
app.listen({ port, host }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IfcStatusCatalogSchema } from "../shared/ifc-status.js";

const ifcKfoDir = path.resolve("data", "ifc-kfo");
const bindingsSchema = z.object({
  schemaVersion: z.literal(1),
  statusAsOf: z.string().min(1),
  kfos: z.array(z.unknown()),
}).passthrough();

async function readJson(fileName: string) {
  return JSON.parse(await readFile(path.join(ifcKfoDir, fileName), "utf8"));
}

export async function readIfcStatusCatalog() {
  return IfcStatusCatalogSchema.parse(await readJson("statuses.json"));
}

export async function readIfcKfoBindings() {
  return bindingsSchema.parse(await readJson("bindings.json"));
}

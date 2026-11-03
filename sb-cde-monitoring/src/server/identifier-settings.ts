import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cloneDefaultIdentifiers,
  IdentifierSettingsSchema,
  SYSTEM_IDENTIFIER_KEYS,
  type IdentifierDefinition,
} from "../shared/identifiers.js";

const SETTINGS_PATH = path.resolve("data/settings/identifiers.json");

function normalizedSettings(identifiers: unknown[]) {
  const migrated = identifiers.map((identifier) => {
    if (!identifier || typeof identifier !== "object") return identifier;
    const value = identifier as Record<string, unknown>;
    return {
      ...value,
      isActive: typeof value.isActive === "boolean"
        ? value.isActive
        : value.key === "kfo" || value.key === "building" || value.key === "floor",
    };
  });
  return IdentifierSettingsSchema.parse({ identifiers: migrated });
}

function settingsHash(identifiers: IdentifierDefinition[]) {
  return createHash("sha256").update(JSON.stringify(identifiers)).digest("hex");
}

export async function readIdentifierSettings() {
  let identifiers: IdentifierDefinition[];
  try {
    const stored = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    identifiers = normalizedSettings(Array.isArray(stored.identifiers) ? stored.identifiers : []).identifiers;
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) throw error;
    identifiers = cloneDefaultIdentifiers();
  }
  return { identifiers, revision: settingsHash(identifiers) };
}

export async function saveIdentifierSettings(input: unknown) {
  const { identifiers } = IdentifierSettingsSchema.parse(input);
  const kfo = identifiers.find((identifier) => identifier.key === "kfo");
  if (!kfo?.isActive) throw new Error("Код КФО — обязательный идентификатор и не может быть выключен.");
  for (const key of SYSTEM_IDENTIFIER_KEYS) {
    if (!identifiers.some((identifier) => identifier.key === key)) {
      throw new Error("В настройках должны присутствовать КФО, корпус, секция и этаж.");
    }
  }
  const keys = new Set<string>();
  for (const identifier of identifiers) {
    if (keys.has(identifier.key)) throw new Error(`Идентификатор с ключом «${identifier.key}» повторяется.`);
    keys.add(identifier.key);
    const values = new Set(identifier.values);
    if (values.size !== identifier.values.length) throw new Error(`В «${identifier.label}» повторяются допустимые значения.`);
    for (const value of Object.keys(identifier.valueAliases)) {
      if (!values.has(value)) throw new Error(`Маппинг «${value}» отсутствует в допустимых значениях «${identifier.label}».`);
    }
  }
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const temporary = `${SETTINGS_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, identifiers }, null, 2)}\n`, "utf8");
  await rename(temporary, SETTINGS_PATH);
  return { identifiers, revision: settingsHash(identifiers) };
}

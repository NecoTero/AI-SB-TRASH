import { z } from "zod";

export const IdentifierDefinitionSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string(),
  isActive: z.boolean(),
  values: z.array(z.string().trim().min(1)),
  attributes: z.array(z.string().trim().min(1)),
  valueAliases: z.record(z.array(z.string().trim().min(1))),
});

export const IdentifierSettingsSchema = z.object({
  identifiers: z.array(IdentifierDefinitionSchema),
});

export type IdentifierDefinition = z.infer<typeof IdentifierDefinitionSchema>;

export const SYSTEM_IDENTIFIER_KEYS = ["kfo", "building", "section", "floor"] as const;
export type SystemIdentifierKey = typeof SYSTEM_IDENTIFIER_KEYS[number];

export function isSystemIdentifierKey(value: string): value is SystemIdentifierKey {
  return SYSTEM_IDENTIFIER_KEYS.some((key) => key === value);
}

export function activeIdentifierKeys(identifiers: IdentifierDefinition[]): SystemIdentifierKey[] {
  return SYSTEM_IDENTIFIER_KEYS.filter((key) =>
    key === "kfo" || identifiers.some((identifier) => identifier.key === key && identifier.isActive));
}

function floorAliases(floor: number) {
  const number = String(floor);
  const padded = floor < 0 ? `-${String(Math.abs(floor)).padStart(2, "0")}` : String(floor).padStart(2, "0");
  return [...new Set([
    `Этаж ${number}`, `Этаж ${padded}`, `Этаж_${number}`, `Этаж_${padded}`,
    `${number} Этаж`, `${padded} Этаж`, `${number}_Этаж`, `${padded}_Этаж`,
    number, padded, `Level ${number}`, `Level ${padded}`,
  ])];
}

const FLOOR_NUMBERS = [-2, -1, 1, 2, 3, 4, 5];
const KFO_VALUES = ["204.02.01.04", "204.02.02.02", "204.02.02.05", "204.02.03.01", "204.02.03.02", "204.02.03.05"];

export const DEFAULT_IDENTIFIERS: IdentifierDefinition[] = [
  {
    key: "kfo",
    label: "Код КФО",
    description: "Классификационный код работы",
    isActive: true,
    values: KFO_VALUES,
    attributes: ["Код по классификатору", "REVIT.Код по классификатору", "Комментарий", "Комментарии", "Код КФО", "КФО", "Spider_Code"],
    valueAliases: Object.fromEntries(KFO_VALUES.map((value) => [value, [value]])),
  },
  {
    key: "building",
    label: "Корпус",
    description: "Корпус или здание объекта",
    isActive: true,
    values: ["Корпус А", "Корпус Б", "Корпус В"],
    attributes: ["О_Здание", "Здание", "REVIT.О_*Здание", "О_*Здание", "О_Зона", "REVIT.О_*Зона", "О_*Зона", "Корпус", "ADSK_Корпус", "INGD_Корпус"],
    valueAliases: {
      "Корпус А": ["Корпус А", "Корпус_А", "А", "A"],
      "Корпус Б": ["Корпус Б", "Корпус_Б", "Б", "B"],
      "Корпус В": ["Корпус В", "Корпус_В", "В", "V"],
    },
  },
  {
    key: "section",
    label: "Секция",
    description: "Секция внутри корпуса",
    isActive: false,
    values: ["Секция 1", "Секция 2", "Секция 3"],
    attributes: ["Секция", "О_Секция", "ADSK_Секция", "INGD_Секция", "Section"],
    valueAliases: {
      "Секция 1": ["Секция 1", "Секция_1", "1 Секция", "1_Секция", "Section 1"],
      "Секция 2": ["Секция 2", "Секция_2", "2 Секция", "2_Секция", "Section 2"],
      "Секция 3": ["Секция 3", "Секция_3", "3 Секция", "3_Секция", "Section 3"],
    },
  },
  {
    key: "floor",
    label: "Этаж",
    description: "Нормализованный этаж для работ и элементов модели",
    isActive: true,
    values: FLOOR_NUMBERS.map((floor) => `Этаж ${floor}`),
    attributes: ["ADSK_Этаж", "Этаж", "INGD_Этаж", "О_Этаж", "Level", "REVIT.О_Этаж", "REVIT.О_*Этаж", "О_*Этаж"],
    valueAliases: Object.fromEntries(FLOOR_NUMBERS.map((floor) => [`Этаж ${floor}`, floorAliases(floor)])),
  },
];

export function cloneDefaultIdentifiers() {
  return structuredClone(DEFAULT_IDENTIFIERS);
}

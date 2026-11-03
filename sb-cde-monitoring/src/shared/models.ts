export const BIM_MODELS = [
  {
    id: "structural",
    fileName: "RD_KR_04-08.ifc",
    title: "v1",
    description: "Исходная модель с правилами назначения КФО",
    sizeLabel: "7,9 МБ",
  },
  {
    id: "full",
    fileName: "1816_PSK_RD_KR_M3_R24.ifc",
    title: "v2",
    description: "Поэлементные КФО, корпуса и этажи из IFC",
    sizeLabel: "55,9 МБ",
  },
] as const;

export type BimModelId = typeof BIM_MODELS[number]["id"];

export function isBimModelId(value: string | undefined): value is BimModelId {
  return BIM_MODELS.some((model) => model.id === value);
}

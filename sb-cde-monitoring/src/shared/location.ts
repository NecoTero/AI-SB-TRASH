import type { OperationLocationSchema } from "./schedule.js";
import type { z } from "zod";

type OperationLocation = z.infer<typeof OperationLocationSchema>;

function clean(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function deriveOperationLocation(
  sourcePath: string[],
  existing?: Partial<OperationLocation>,
): OperationLocation {
  let building = existing?.building ?? null;
  let section = existing?.section ?? null;
  let floor = existing?.floor ?? null;
  const evidence = [...(existing?.evidence ?? [])];

  for (const rawName of sourcePath) {
    const name = clean(rawName);
    if (!building) {
      const match = name.match(/корпус\s+([А-ЯЁA-Z])/iu);
      if (match) {
        building = `Корпус ${match[1].toLocaleUpperCase("ru")}`;
        evidence.push(`Корпус из узла дерева: ${name}`);
      }
    }
    if (!section) {
      const match = name.match(/секци(?:я|и)\s+([А-ЯЁA-Z0-9._-]+)/iu);
      if (match) {
        section = `Секция ${match[1].toLocaleUpperCase("ru")}`;
        evidence.push(`Секция из узла дерева: ${name}`);
      }
    }
    if (!floor && /подземная часть/iu.test(name)) {
      floor = "Этаж -1";
      evidence.push(`Этаж из узла дерева: ${name}`);
    }
    if (!floor) {
      const match = name.match(/(?:^|\D)(-?\d+)\s*этаж/iu);
      if (match) {
        floor = `Этаж ${Number(match[1])}`;
        evidence.push(`Этаж из узла дерева: ${name}`);
      }
    }
  }

  return {
    building,
    section,
    floor,
    sourcePath: [...sourcePath],
    evidence: [...new Set(evidence)],
  };
}

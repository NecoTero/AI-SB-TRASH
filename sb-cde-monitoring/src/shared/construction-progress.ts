export type ConstructionProgress = {
  visible: boolean;
  source: "actual" | "plan" | "none";
  completionDate: string | null;
};

function day(value: string | null | undefined) {
  return value?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

/**
 * An element joins the cumulative construction view on its completion day.
 * A recorded actual finish is authoritative; otherwise the planned finish is used.
 */
export function calculateConstructionProgress(
  actualFinish: string | null | undefined,
  plannedFinish: string | null | undefined,
  selectedDate: string,
): ConstructionProgress {
  const actual = day(actualFinish);
  const planned = day(plannedFinish);
  const completionDate = actual ?? planned;
  const source = actual ? "actual" : planned ? "plan" : "none";
  return {
    visible: completionDate !== null && completionDate <= selectedDate,
    source,
    completionDate,
  };
}

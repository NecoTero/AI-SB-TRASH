import type { SourceOperation } from "./schedule.js";

export type TimelineArea = "fact" | "plan";
export type ConstructionStatus = "not_started" | "in_progress" | "completed" | "diagnostic";
export type ScheduleDeviation =
  | "overdue"
  | "on_schedule"
  | "ahead"
  | "not_calculated"
  | "no_baseline"
  | "no_data";

export type CalculatedOperationStatus = {
  operationId: string;
  selectedDate: string;
  reportDate: string;
  area: TimelineArea;
  constructionStatus: ConstructionStatus;
  statusSource: "actual" | "plan" | "diagnostic";
  deviation: ScheduleDeviation;
  deviationReason: string;
  diagnostics: string[];
};

function day(value: string | null | undefined) {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function compareCompletion(value: string, baselineFinish: string) {
  if (value < baselineFinish) return "ahead" as const;
  if (value > baselineFinish) return "overdue" as const;
  return "on_schedule" as const;
}

export function calculateOperationStatus(
  operation: SourceOperation,
  baselineOperation: SourceOperation | null,
  selectedDate: string,
  reportDate: string,
): CalculatedOperationStatus {
  const actualStart = day(operation.actualStart);
  const actualFinish = day(operation.actualFinish);
  const plannedStart = day(operation.start);
  const plannedFinish = day(operation.finish);
  const baselineStart = day(baselineOperation?.start);
  const baselineFinish = day(baselineOperation?.finish);
  const diagnostics: string[] = [];
  const area: TimelineArea = selectedDate <= reportDate ? "fact" : "plan";

  if (actualFinish && !actualStart) diagnostics.push("Фактическое окончание задано без фактического начала.");
  if (actualStart && actualFinish && actualFinish < actualStart) diagnostics.push("Фактическое окончание раньше фактического начала.");
  if (plannedStart && plannedFinish && plannedFinish < plannedStart) diagnostics.push("Плановое окончание раньше планового начала.");

  let constructionStatus: ConstructionStatus = "diagnostic";
  let statusSource: CalculatedOperationStatus["statusSource"] = "diagnostic";
  let completionForDeviation: string | null = null;
  let missedOperationalFinish = false;

  if (!diagnostics.length && area === "fact") {
    statusSource = "actual";
    if (actualFinish && actualFinish <= selectedDate) {
      constructionStatus = "completed";
      completionForDeviation = actualFinish;
    } else if (actualStart && actualStart <= selectedDate && (!actualFinish || actualFinish > selectedDate)) {
      constructionStatus = "in_progress";
    } else {
      constructionStatus = "not_started";
    }
  } else if (!diagnostics.length) {
    if (actualFinish && actualFinish <= reportDate) {
      constructionStatus = "completed";
      statusSource = "actual";
      completionForDeviation = actualFinish;
    } else if (!actualFinish && plannedFinish && plannedFinish < reportDate) {
      constructionStatus = "in_progress";
      statusSource = actualStart ? "actual" : "plan";
      missedOperationalFinish = true;
      if (!actualStart) diagnostics.push("Плановое окончание пропущено, но фактическое начало отсутствует.");
    } else if (!actualFinish && plannedFinish && plannedFinish > reportDate && selectedDate >= plannedFinish) {
      constructionStatus = "completed";
      statusSource = "plan";
      completionForDeviation = plannedFinish;
    } else if (plannedFinish === reportDate && !actualFinish) {
      diagnostics.push("Плановое окончание совпадает с отчётной датой; правило границы требует уточнения.");
      constructionStatus = "diagnostic";
      statusSource = "diagnostic";
    } else if (
      (actualStart && actualStart <= reportDate) ||
      (plannedStart && plannedFinish && plannedStart <= selectedDate && selectedDate < plannedFinish)
    ) {
      constructionStatus = "in_progress";
      statusSource = actualStart ? "actual" : "plan";
    } else if (!actualStart && plannedStart && selectedDate < plannedStart) {
      constructionStatus = "not_started";
      statusSource = "plan";
    } else {
      diagnostics.push("Недостаточно дат для определения статуса СМР.");
    }
  }

  let deviation: ScheduleDeviation = "not_calculated";
  let deviationReason = "Незадержанная незавершённая ветвь не формализована пользователем.";
  if (!baselineOperation) {
    deviation = "no_baseline";
    deviationReason = "Соответствующая операция отсутствует в базовом графике.";
  } else if (constructionStatus === "diagnostic") {
    deviation = "no_data";
    deviationReason = "Некорректные или неполные даты не позволяют выполнить сравнение.";
  } else if (missedOperationalFinish) {
    deviation = "overdue";
    deviationReason = "Плановое окончание актуального графика прошло до отчётной даты, фактического окончания нет.";
  } else if (completionForDeviation && baselineFinish) {
    deviation = compareCompletion(completionForDeviation, baselineFinish);
    deviationReason = `${statusSource === "actual" ? "Фактическое" : "Плановое"} окончание сопоставлено с базовым окончанием.`;
  } else if (!baselineFinish && !baselineStart) {
    deviation = "no_data";
    deviationReason = "В базовом графике отсутствуют даты для сравнения.";
  } else {
    const currentStart = actualStart && actualStart <= selectedDate
      ? actualStart
      : area === "plan" ? plannedStart : null;
    if (baselineFinish && baselineFinish < selectedDate && constructionStatus !== "completed") {
      deviation = "overdue";
      deviationReason = "Базовое окончание прошло, завершения нет.";
    } else if (baselineStart && baselineStart <= selectedDate && !currentStart) {
      deviation = "overdue";
      deviationReason = "По базовому графику операция должна была начаться, но начало не наступило.";
    } else if (baselineStart && currentStart && currentStart > baselineStart) {
      deviation = "overdue";
      deviationReason = "Начало позже базовой даты; просрочка сохраняется до завершения.";
    }
  }

  return {
    operationId: operation.snapshotOperationId,
    selectedDate,
    reportDate,
    area,
    constructionStatus,
    statusSource,
    deviation,
    deviationReason,
    diagnostics,
  };
}

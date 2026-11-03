import type { MonitoringSnapshot, MonitoringStatusPatch } from "../shared/monitoring.js";

export function mergeMonitoringStatusPatch(
  current: MonitoringSnapshot,
  patch: MonitoringStatusPatch,
): MonitoringSnapshot {
  if (
    current.scheduleId !== patch.scheduleId
    || current.versionId !== patch.versionId
    || current.modelId !== patch.modelId
  ) return current;
  const statusByWorkId = new Map(patch.statuses.map((item) => [item.workId, item.status]));
  const statusByModelWorkId = new Map(patch.modelWorkStatuses.map((item) => [item.workId, item.status]));
  return {
    ...current,
    selectedDate: patch.selectedDate,
    reportDate: patch.reportDate,
    works: current.works.map((work) => {
      const status = statusByWorkId.get(work.workId);
      return status ? {
        ...work,
        status: {
          operationId: work.operationId,
          selectedDate: patch.selectedDate,
          reportDate: patch.reportDate,
          ...status,
        },
      } : work;
    }),
    modelWorks: current.modelWorks.map((work) => {
      const status = statusByModelWorkId.get(work.workId);
      return status ? {
        ...work,
        status: {
          operationId: work.workId,
          selectedDate: patch.selectedDate,
          reportDate: patch.reportDate,
          ...status,
        },
      } : work;
    }),
    summary: { ...current.summary, statusCounts: patch.statusCounts },
  };
}

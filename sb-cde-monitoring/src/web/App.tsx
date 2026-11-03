import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  MAX_SCHEDULE_OPERATIONS,
  type ProjectSchedule, type ScheduleTreeRow, type ScheduleVersionMetadata, type SourceOperation,
} from "../shared/schedule";
import type {
  ModelWorkGroup, ModelWorksResponse, MonitoringSnapshot, MonitoringStatusPatch, MonitoringWork,
} from "../shared/monitoring";
import { BIM_MODELS, type BimModelId } from "../shared/models";
import { collapsedRowsForLevel, treeRowsForOperationIds } from "./tree-state";
import { mergeMonitoringStatusPatch } from "./monitoring-state";
import { focusedOperationDateBounds, operationDateBounds } from "../shared/timeline";
import {
  activeIdentifierKeys, cloneDefaultIdentifiers, isSystemIdentifierKey,
  type IdentifierDefinition, type SystemIdentifierKey,
} from "../shared/identifiers";

const IfcViewer = lazy(() => import("./IfcViewerOptimized").then((module) => ({ default: module.IfcViewer })));
type Screen = "monitoring" | "works" | "settings" | "import";
type ImportWizardMode = "import" | "configure";

type ImportConfiguration = {
  file: File;
  kind: "baseline" | "operational";
  baselineVersionId: string;
  effectiveStatusDate: string;
  identifierKeys: SystemIdentifierKey[];
  ifcModelIds: BimModelId[];
  activeModelId: BimModelId;
};

const IFC_MODEL_META: Record<BimModelId, { discipline: string; scope: string }> = {
  structural: { discipline: "КР · Конструктив", scope: "Корпуса 04–08" },
  full: { discipline: "КР · Детальная модель", scope: "Корпуса А, Б и В" },
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? "Ошибка запроса");
  return body as T;
}

function latest(items: ScheduleVersionMetadata[]) {
  return [...items].sort((a, b) =>
    `${b.effectiveStatusDate}|${b.importedAt}`.localeCompare(`${a.effectiveStatusDate}|${a.importedAt}`),
  )[0] ?? null;
}

export function App() {
  const [screen, setScreen] = useState<Screen>("works");
  const [schedules, setSchedules] = useState<ProjectSchedule[]>([]);
  const [scheduleId, setScheduleId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [operations, setOperations] = useState<SourceOperation[]>([]);
  const [treeRows, setTreeRows] = useState<ScheduleTreeRow[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [deletingVersionId, setDeletingVersionId] = useState("");
  const [versionMenuOpen, setVersionMenuOpen] = useState(false);
  const [statusDateDraft, setStatusDateDraft] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [monitoring, setMonitoring] = useState<MonitoringSnapshot | null>(null);
  const [selectedIfcModelIds, setSelectedIfcModelIds] = useState<BimModelId[]>([]);
  const [activeModelId, setActiveModelId] = useState<BimModelId>("structural");
  const [importWizardMode, setImportWizardMode] = useState<ImportWizardMode>("import");
  const [importWizardStep, setImportWizardStep] = useState(1);
  const [identifiers, setIdentifiers] = useState<IdentifierDefinition[]>(() => cloneDefaultIdentifiers());
  const [identifiersLoading, setIdentifiersLoading] = useState(true);

  const schedule = schedules.find((item) => item.id === scheduleId) ?? null;
  const version = schedule?.versions.find((item) => item.id === versionId) ?? null;
  const actualSchedule = [...schedules].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const actualVersionId = latest(schedule?.versions ?? [])?.id ?? "";
  const hasScheduleData = schedules.some((item) => item.versions.length > 0);
  const modelConnected = selectedIfcModelIds.length > 0;

  async function refresh(preferred?: string) {
    const result = await api<ProjectSchedule[]>("/api/schedules");
    setSchedules(result);
    setScheduleId(
      result.find((item) => item.id === preferred)?.id
      ?? result.find((item) => item.id === scheduleId)?.id
      ?? result[0]?.id
      ?? "",
    );
    return result;
  }

  useEffect(() => { refresh().catch((error) => setMessage(error.message)); }, []);
  useEffect(() => {
    let active = true;
    api<{ identifiers: IdentifierDefinition[] }>("/api/settings/identifiers")
      .then((result) => { if (active) setIdentifiers(result.identifiers); })
      .catch((error: Error) => { if (active) setMessage(error.message); })
      .finally(() => { if (active) setIdentifiersLoading(false); });
    return () => { active = false; };
  }, []);

  const activeIdentifierSignature = activeIdentifierKeys(identifiers).join("|");

  useEffect(() => {
    if (!schedule) { setVersionId(""); return; }
    if (!schedule.versions.some((item) => item.id === versionId)) {
      setVersionId(latest(schedule.versions)?.id ?? "");
    }
  }, [scheduleId, schedules]);

  useEffect(() => {
    if (!scheduleId || !versionId) { setOperations([]); setTreeRows([]); return; }
    setBusy(true);
    Promise.all([
      api<{ items: SourceOperation[]; total: number }>(`/api/schedules/${scheduleId}/versions/${versionId}/operations?limit=${MAX_SCHEDULE_OPERATIONS}`),
      api<{ items: ScheduleTreeRow[] }>(`/api/schedules/${scheduleId}/versions/${versionId}/tree`),
    ])
      .then(([operationsResult, treeResult]) => {
        setOperations(operationsResult.items);
        setTreeRows(treeResult.items);
        if (operationsResult.total > MAX_SCHEDULE_OPERATIONS) {
          setMessage(`В сохранённом графике ${operationsResult.total.toLocaleString("ru-RU")} операций. Показаны только первые ${MAX_SCHEDULE_OPERATIONS.toLocaleString("ru-RU")}.`);
        }
      })
      .catch((error) => setMessage(error.message))
      .finally(() => setBusy(false));
  }, [scheduleId, versionId]);

  useEffect(() => {
    setStatusDateDraft(version?.effectiveStatusDate ?? "");
    setSelectedDate(version?.effectiveStatusDate ?? "");
    setMonitoring(null);
  }, [version?.id]);

  useEffect(() => {
    if (!schedule || !version || !statusDateDraft || statusDateDraft === version.effectiveStatusDate) return;
    const scheduleIdToSave = schedule.id;
    const versionIdToSave = version.id;
    const dateToSave = statusDateDraft;
    const timer = window.setTimeout(() => {
      setSavingVersion(true);
      api<{ schedule: ProjectSchedule; version: ScheduleVersionMetadata }>(
        `/api/schedules/${scheduleIdToSave}/versions/${versionIdToSave}/status-date`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ effectiveStatusDate: dateToSave }),
        },
      ).then((result) => {
        setSchedules((current) => current.map((item) => item.id === result.schedule.id ? result.schedule : item));
        setMonitoring(null);
        setMessage(`Отчётная дата ${result.version.effectiveStatusDate} сохранена.`);
      }).catch((error) => {
        setMessage(error instanceof Error ? error.message : "Ошибка сохранения отчётной даты");
      }).finally(() => setSavingVersion(false));
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [schedule?.id, version?.id, version?.effectiveStatusDate, statusDateDraft]);

  useEffect(() => { setMonitoring(null); }, [activeModelId]);

  useEffect(() => {
    if (!modelConnected || !scheduleId || !versionId || !selectedDate) { setMonitoring(null); return; }
    const controller = new AbortController();
    const canPatch = monitoring?.scheduleId === scheduleId
      && monitoring.versionId === versionId
      && monitoring.modelId === activeModelId;
    const timer = window.setTimeout(() => {
      const url = `/api/schedules/${scheduleId}/versions/${versionId}/monitoring?date=${selectedDate}&modelId=${activeModelId}${canPatch ? "&compact=1" : ""}`;
      const request = canPatch
        ? api<MonitoringStatusPatch>(url, { signal: controller.signal }).then((patch) => {
          if (patch.selectedDate === selectedDate) {
            setMonitoring((current) => current ? mergeMonitoringStatusPatch(current, patch) : current);
          }
        })
        : api<MonitoringSnapshot>(url, { signal: controller.signal }).then((snapshot) => {
          if (snapshot.selectedDate === selectedDate) setMonitoring(snapshot);
        });
      request
        .catch((error) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) setMessage(error.message);
        });
    }, 35);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [modelConnected, scheduleId, versionId, version?.effectiveStatusDate, selectedDate, activeModelId, activeIdentifierSignature]);

  async function importXml(configuration: ImportConfiguration) {
    setBusy(true);
    try {
      const selected = new Set<SystemIdentifierKey>(["kfo", ...configuration.identifierKeys]);
      const nextIdentifiers = identifiers.map((identifier) => isSystemIdentifierKey(identifier.key)
        ? { ...identifier, isActive: selected.has(identifier.key) }
        : identifier);
      const savedSettings = await api<{ identifiers: IdentifierDefinition[] }>("/api/settings/identifiers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers: nextIdentifiers }),
      });
      setIdentifiers(savedSettings.identifiers);
      const form = new FormData();
      if (schedule) form.set("scheduleId", schedule.id);
      form.set("kind", configuration.kind);
      if (configuration.kind === "operational") form.set("basedOnBaselineVersionId", configuration.baselineVersionId);
      form.set("effectiveStatusDate", configuration.effectiveStatusDate);
      form.set("file", configuration.file);
      const result = await api<{ schedule: ProjectSchedule; version: ScheduleVersionMetadata }>(
        "/api/schedules/import", { method: "POST", body: form },
      );
      await refresh(result.schedule.id);
      setVersionId(result.version.id);
      setActiveModelId(configuration.activeModelId);
      setSelectedIfcModelIds(configuration.ifcModelIds);
      setMonitoring(null);
      setMessage(`График импортирован: ${result.version.cmrOperationCount} операций.`);
      setScreen("works");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ошибка импорта");
    } finally { setBusy(false); }
  }

  async function applyExistingConfiguration(
    selectedKeys: SystemIdentifierKey[],
    ifcModelIds: BimModelId[],
    modelId: BimModelId,
  ) {
    setBusy(true);
    try {
      const selected = new Set<SystemIdentifierKey>(["kfo", ...selectedKeys]);
      const nextIdentifiers = identifiers.map((identifier) => isSystemIdentifierKey(identifier.key)
        ? { ...identifier, isActive: selected.has(identifier.key) }
        : identifier);
      const savedSettings = await api<{ identifiers: IdentifierDefinition[] }>("/api/settings/identifiers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers: nextIdentifiers }),
      });
      setIdentifiers(savedSettings.identifiers);
      setActiveModelId(modelId);
      setSelectedIfcModelIds(ifcModelIds);
      setMonitoring(null);
      setMessage(`Настройки применены: ${ifcModelIds.length} IFC-моделей.`);
      setScreen("works");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось применить настройки.");
    } finally {
      setBusy(false);
    }
  }

  function openImportWizard(step = 1, mode: ImportWizardMode = "import") {
    setImportWizardMode(mode);
    setImportWizardStep(step);
    setScreen("import");
  }

  async function deleteVersion(targetVersion: ScheduleVersionMetadata) {
    if (!schedule) return;
    if (!window.confirm(`Удалить версию «${formatVersionOption(targetVersion, actualVersionId)} · ${targetVersion.effectiveStatusDate}»? Это действие нельзя отменить.`)) return;
    setDeletingVersionId(targetVersion.id);
    try {
      const result = await api<{ schedule: ProjectSchedule | null; deletedVersion: ScheduleVersionMetadata }>(
        `/api/schedules/${schedule.id}/versions/${targetVersion.id}`,
        { method: "DELETE" },
      );
      const refreshed = await refresh(result.schedule?.id);
      const nextSchedule = result.schedule ?? refreshed[0] ?? null;
      setScheduleId(nextSchedule?.id ?? "");
      setVersionId(nextSchedule?.versions.some((item) => item.id === versionId)
        ? versionId
        : latest(nextSchedule?.versions ?? [])?.id ?? "");
      if (!nextSchedule?.versions.length) setVersionMenuOpen(false);
      setMessage(`Версия от ${result.deletedVersion.effectiveStatusDate} удалена.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ошибка удаления версии");
    } finally {
      setDeletingVersionId("");
    }
  }

  function openMonitoring() {
    const targetSchedule = actualSchedule;
    const targetVersion = latest(targetSchedule?.versions ?? []);
    if (targetSchedule) setScheduleId(targetSchedule.id);
    if (targetVersion) setVersionId(targetVersion.id);
    setVersionMenuOpen(false);
    setScreen("monitoring");
  }

  function selectVersion(item: ScheduleVersionMetadata) {
    if (screen === "monitoring" && item.id !== actualVersionId) {
      setMessage("В «Мониторинге» доступна только актуальная версия графика. Исторические версии пока можно просматривать в «Работах».");
      return;
    }
    setVersionId(item.id);
    setVersionMenuOpen(false);
  }

  function renderVersionPicker(lockHistorical: boolean) {
    return <div className="version-picker"><span>Версия графика</span><button className="version-picker-trigger" type="button" disabled={!schedule?.versions.length} aria-expanded={versionMenuOpen} onClick={() => setVersionMenuOpen((open) => !open)}><span>{version ? `${formatVersionOption(version, actualVersionId)} · ${version.effectiveStatusDate}` : "Нет версий"}</span><i /></button>{versionMenuOpen && <><button className="version-menu-dismiss" type="button" aria-label="Закрыть список версий" onClick={() => setVersionMenuOpen(false)} /><div className="version-menu">{schedule?.versions.map((item) => { const dependentCount = item.kind === "baseline" ? schedule.versions.filter((candidate) => candidate.basedOnBaselineVersionId === item.id).length : 0; const locked = lockHistorical && item.id !== actualVersionId; return <div className={`version-menu-row ${item.id === versionId ? "active" : ""} ${locked ? "locked" : ""}`} key={item.id}><button className="version-menu-select" type="button" aria-disabled={locked} title={locked ? "Исторические версии недоступны в Мониторинге" : undefined} onClick={() => selectVersion(item)}><strong>{formatVersionOption(item, actualVersionId)}</strong><small>{item.effectiveStatusDate} · {item.originalFileName}{locked ? " · недоступно в Мониторинге" : ""}</small></button><button className="version-menu-delete" type="button" aria-label={`Удалить версию от ${item.effectiveStatusDate}`} title={lockHistorical ? "Управление версиями доступно в Работах" : dependentCount ? `Сначала удалите связанные операционные версии (${dependentCount})` : "Удалить версию"} disabled={lockHistorical || Boolean(dependentCount) || deletingVersionId === item.id} onClick={() => void deleteVersion(item)}>{deletingVersionId === item.id ? "…" : "×"}</button></div>; })}</div></>}</div>;
  }

  return <div className="app-shell">
    <header><div className="brand"><span>SB_CDE</span><strong>Мониторинг строительства</strong></div>
      {hasScheduleData && <nav>
        <button className={screen === "monitoring" ? "active" : ""} onClick={openMonitoring}>Мониторинг</button>
        <button className={screen === "works" || screen === "import" ? "active" : ""} onClick={() => setScreen("works")}>Работы</button>
        <button className={screen === "settings" ? "active" : ""} onClick={() => setScreen("settings")}>Настройки</button>
      </nav>}</header>
    {screen === "monitoring" && hasScheduleData && <section className="context-bar">{renderVersionPicker(true)}</section>}
    {message && <div className="notice" onClick={() => setMessage("")}>{message}</div>}
    <main>
      {screen === "monitoring" && (modelConnected
        ? <Monitoring monitoring={monitoring} operations={operations} selectedDate={selectedDate} modelId={activeModelId} onDateChange={setSelectedDate} />
        : <section className="workspace model-connection-empty monitoring-connection-empty"><span className="model-connection-icon">◇</span><h2>Сначала выберите IFC-модели</h2><p>Viewer не загружает IFC автоматически. Выберите нужные файлы и основную IFC-модель для мониторинга.</p><button type="button" className="primary" onClick={() => openImportWizard(2, "configure")}>Настроить данные</button></section>)}
      {screen === "works" && <Works scheduleId={scheduleId} operations={operations} treeRows={treeRows} version={version} monitoring={monitoring} busy={busy} modelConnected={modelConnected} activeModelId={activeModelId} selectedIfcModelIds={selectedIfcModelIds} identifiers={identifiers} graphControls={<>{renderVersionPicker(false)}<label className="works-report-date"><span>Отчётная дата</span><input type="date" value={statusDateDraft} disabled={!version} onChange={(event) => setStatusDateDraft(event.target.value)} /><small>{!version ? "Нет выбранной версии" : savingVersion ? "Сохраняю…" : statusDateDraft !== version.effectiveStatusDate ? "Автосохранение через 5 секунд" : "Сохранено"}</small></label></>} onImport={() => openImportWizard(1, "import")} onConfigureModels={() => openImportWizard(2, "configure")} />}
      {screen === "settings" && <Settings identifiers={identifiers} loading={identifiersLoading} version={version} statusDate={statusDateDraft} savingVersion={savingVersion} onStatusDateChange={setStatusDateDraft} onIdentifiersChange={(next) => { setIdentifiers(next); setMonitoring(null); }} />}
      {screen === "import" && <ImportForm schedule={schedule} hasSchedules={Boolean(schedules.length)} identifiers={identifiers} selectedIfcModelIds={selectedIfcModelIds} activeModelId={activeModelId} initialStep={importWizardStep} mode={importWizardMode} busy={busy || identifiersLoading} submit={importXml} applyConfiguration={applyExistingConfiguration} close={() => setScreen("works")} />}
    </main>
  </div>;
}

function formatVersionOption(item: ScheduleVersionMetadata, actualVersionId = "") {
  if (item.kind === "baseline") return item.id === actualVersionId ? "Базовый · актуальный" : "Базовый";
  return item.id === actualVersionId ? "Актуальный" : "Исторический";
}

function dayNumber(value: string) {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
}

function dateFromDayNumber(value: number) {
  return new Date(value * 86_400_000).toISOString().slice(0, 10);
}

function formatDisplayDate(value: string) {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}.${month}.${year}` : value;
}

function timelineTicks(startDay: number, endDay: number) {
  const span = Math.max(1, endDay - startDay);
  const position = (day: number) => ((day - startDay) / span) * 100;
  const weekStep = span <= 140 ? 7 : span <= 365 ? 14 : 28;
  const weekTicks: number[] = [];
  const startWeekday = new Date(startDay * 86_400_000).getUTCDay();
  let week = startDay + ((8 - startWeekday) % 7 || 7);
  for (; week < endDay; week += weekStep) weekTicks.push(position(week));

  const monthTicks: Array<{ position: number; label: string }> = [];
  const first = new Date(startDay * 86_400_000);
  let month = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1) / 86_400_000;
  const labelStep = span <= 240 ? 1 : span <= 600 ? 2 : 3;
  let monthIndex = 0;
  for (; month < endDay; month = Date.UTC(new Date(month * 86_400_000).getUTCFullYear(), new Date(month * 86_400_000).getUTCMonth() + 1, 1) / 86_400_000) {
    const date = new Date(month * 86_400_000);
    monthTicks.push({
      position: position(month),
      label: monthIndex % labelStep === 0
        ? new Intl.DateTimeFormat("ru-RU", { month: "short", year: date.getUTCMonth() === 0 ? "2-digit" : undefined, timeZone: "UTC" }).format(date)
        : "",
    });
    monthIndex += 1;
  }
  return { weekTicks, monthTicks };
}

function Monitoring({ monitoring, operations, selectedDate, modelId, onDateChange }: {
  monitoring: MonitoringSnapshot | null;
  operations: SourceOperation[];
  selectedDate: string;
  modelId: BimModelId;
  onDateChange: (value: string) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [stepDays, setStepDays] = useState<1 | 3 | 7>(1);
  const [timelineFocused, setTimelineFocused] = useState(false);
  const fullBounds = useMemo(
    () => operationDateBounds(operations, selectedDate || new Date().toISOString().slice(0, 10)),
    [operations, selectedDate],
  );
  const linkedOperationIds = useMemo(() => new Set(
    monitoring?.modelWorks.flatMap((work) => work.operationIds) ?? [],
  ), [monitoring]);
  const bimBounds = useMemo(
    () => focusedOperationDateBounds(operations, linkedOperationIds, fullBounds),
    [operations, linkedOperationIds, fullBounds],
  );
  const bounds = timelineFocused && bimBounds ? bimBounds : fullBounds;
  const startDay = dayNumber(bounds.start);
  const endDay = dayNumber(bounds.end);
  const selectedDay = selectedDate ? dayNumber(selectedDate) : startDay;
  const reportDate = monitoring?.reportDate ?? "";
  const areaLabel = reportDate && selectedDate <= reportDate ? "Фактическая область" : "Плановая область";
  const ticks = useMemo(() => timelineTicks(startDay, endDay), [startDay, endDay]);
  const reportDay = reportDate ? dayNumber(reportDate) : null;
  const reportInBounds = reportDay !== null && reportDay >= startDay && reportDay <= endDay;
  const reportPosition = reportInBounds ? ((reportDay - startDay) / Math.max(1, endDay - startDay)) * 100 : reportDay !== null && reportDay < startDay ? 0 : 100;
  const playbackWaiting = playing && monitoring?.selectedDate !== selectedDate;

  useEffect(() => {
    if (!playing || !operations.length) return;
    if (monitoring?.selectedDate !== selectedDate) return;
    const timer = window.setTimeout(() => {
      const currentDay = dayNumber(selectedDate || bounds.start);
      if (currentDay >= endDay) {
        setPlaying(false);
        return;
      }
      onDateChange(dateFromDayNumber(Math.min(endDay, currentDay + stepDays)));
    }, 260);
    return () => window.clearTimeout(timer);
  }, [playing, selectedDate, monitoring?.selectedDate, stepDays, endDay, bounds.start, operations.length, onDateChange]);

  const togglePlayback = () => {
    if (!playing && selectedDay >= endDay) onDateChange(bounds.start);
    setPlaying((current) => !current);
  };

  const toggleTimelineFocus = () => {
    setPlaying(false);
    const nextFocused = !timelineFocused;
    setTimelineFocused(nextFocused);
    const nextBounds = nextFocused && bimBounds ? bimBounds : fullBounds;
    if (selectedDate < nextBounds.start) onDateChange(nextBounds.start);
    else if (selectedDate > nextBounds.end) onDateChange(nextBounds.end);
  };

  return <section className="monitoring-surface">
    <Suspense fallback={<div className="viewer-empty">Подготавливаем IFC viewer…</div>}><IfcViewer monitoring={monitoring} modelId={modelId} /></Suspense>
    <div className="timeline-bar">
      <div className="timeline-head">
        <div className="timeline-label"><span>Выбранная дата</span><strong>{selectedDate ? `${formatDisplayDate(selectedDate)} · ${areaLabel}` : "Выберите график"}</strong></div>
        <div className="timeline-step"><span>Шаг</span><div className="segmented"><button className={stepDays === 1 ? "active" : ""} onClick={() => setStepDays(1)}>1 день</button><button className={stepDays === 3 ? "active" : ""} onClick={() => setStepDays(3)}>3 дня</button><button className={stepDays === 7 ? "active" : ""} onClick={() => setStepDays(7)}>1 неделя</button></div></div>
        <div className="timeline-actions">
          <input aria-label="Выбранная дата" type="date" min={bounds.start} max={bounds.end} value={selectedDate} onChange={(event) => { setPlaying(false); onDateChange(event.target.value); }} />
          <button className={playing ? "playing" : ""} onClick={togglePlayback} disabled={!operations.length}>{playing ? "Ⅱ Пауза" : "▶ Проиграть"}</button>
          <span className={`timeline-updating${playbackWaiting ? " visible" : ""}`} role="status">Обновление…</span>
          <button className={timelineFocused ? "focused" : ""} title="Показать диапазон BIM-связанных работ с запасом 7 дней с каждой стороны" onClick={toggleTimelineFocus} disabled={!bimBounds}>{timelineFocused ? "Весь график" : "Фокус на BIM-работах"}</button>
        </div>
      </div>
      <div className="timeline-range"><span>{timelineFocused ? "BIM-фокус" : "Весь график"}: {formatDisplayDate(bounds.start)} — {formatDisplayDate(bounds.end)}</span><div className="timeline-scale"><div className="timeline-track"><span className="timeline-zone fact" style={{ width: `${reportPosition}%` }} /><span className="timeline-zone plan" style={{ left: `${reportPosition}%` }} />{ticks.weekTicks.map((position) => <i className="timeline-tick week" key={`w-${position}`} style={{ left: `${position}%` }} />)}{ticks.monthTicks.map((tick) => <i className="timeline-tick month" key={`m-${tick.position}`} style={{ left: `${tick.position}%` }} />)}{reportInBounds && <i className="timeline-report-mark" style={{ left: `${reportPosition}%` }} />}<input aria-label="Шкала времени" type="range" min={startDay} max={Math.max(startDay, endDay)} value={Math.min(Math.max(selectedDay, startDay), endDay)} onChange={(event) => { setPlaying(false); onDateChange(dateFromDayNumber(Number(event.target.value))); }} disabled={!operations.length} /></div><div className="timeline-tick-labels">{ticks.monthTicks.filter((tick) => tick.label).map((tick) => <span key={`l-${tick.position}`} style={{ left: `${tick.position}%` }}>{tick.label}</span>)}{reportInBounds && <b style={{ left: `${Math.min(94, Math.max(6, reportPosition))}%` }}>Отчётная дата · {formatDisplayDate(reportDate)}</b>}</div></div></div>
    </div>
  </section>;
}

type GroupNode = { path: string; label: string; depth: number; operations: SourceOperation[]; children: GroupNode[] };
type VisibleGroupRow = { kind: "group"; node: GroupNode } | { kind: "operation"; operation: SourceOperation; depth: number };

function operationIdentifierValue(operation: SourceOperation, key: SystemIdentifierKey) {
  if (key === "kfo") return operation.kfoCode;
  return operation.location[key];
}

function operationIdentifierLabel(operation: SourceOperation, key: SystemIdentifierKey) {
  if (key === "kfo") {
    const code = operation.kfoCode ?? "КФО не указан";
    return operation.kfoName ? `${code} — ${operation.kfoName}` : code;
  }
  const labels: Record<Exclude<SystemIdentifierKey, "kfo">, string> = {
    building: "Корпус не указан",
    section: "Секция не указана",
    floor: "Этаж не указан",
  };
  return operation.location[key] ?? labels[key];
}

function buildScheduleGroups(
  operations: SourceOperation[],
  keys: readonly SystemIdentifierKey[],
): GroupNode[] {
  const buckets = new Map<string, { label: string; operations: SourceOperation[] }>();
  for (const operation of operations) {
    const path = `schedule/${scheduleWorkIdentity(operation, keys)}`;
    const bucket = buckets.get(path) ?? {
      label: keys.map((key) => operationIdentifierLabel(operation, key)).join(" · "),
      operations: [],
    };
    bucket.operations.push(operation);
    buckets.set(path, bucket);
  }
  return [...buckets.entries()]
    .sort(([, left], [, right]) => left.label.localeCompare(right.label, "ru", { numeric: true }))
    .map(([path, bucket]) => ({
      path,
      label: bucket.label,
      depth: 0,
      operations: bucket.operations,
      children: [],
    }));
}

function visibleGroupRows(nodes: GroupNode[], collapsed: Set<string>): VisibleGroupRow[] {
  const rows: VisibleGroupRow[] = [];
  for (const node of nodes) {
    rows.push({ kind: "group", node });
    if (collapsed.has(node.path)) continue;
    if (node.children.length) rows.push(...visibleGroupRows(node.children, collapsed));
    else rows.push(...node.operations.map((operation) => ({ kind: "operation" as const, operation, depth: node.depth + 1 })));
  }
  return rows;
}

function allGroupPaths(nodes: GroupNode[]): string[] {
  return nodes.flatMap((node) => [node.path, ...allGroupPaths(node.children)]);
}

type ScheduleGroupSummary = {
  plannedStart: string | null;
  plannedFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  actualFinishIsPartial: boolean;
  percentComplete: number | null;
  constructionStatus: MonitoringWork["status"]["constructionStatus"] | null;
  statusArea: MonitoringWork["status"]["area"] | null;
  deviation: MonitoringWork["status"]["deviation"] | null;
  elementCount: number;
};

function firstDate(values: Array<string | null>, direction: "min" | "max") {
  const present = values.filter((value): value is string => Boolean(value));
  if (!present.length) return null;
  return present.sort((left, right) => direction === "min"
    ? left.localeCompare(right)
    : right.localeCompare(left))[0];
}

function scheduleWorkIdentity(operation: SourceOperation, keys: readonly SystemIdentifierKey[]) {
  return keys.map((key) => operationIdentifierValue(operation, key))
    .map((value) => value ?? "")
    .map(encodeURIComponent)
    .join("|");
}

function summarizeScheduleGroup(
  node: GroupNode,
  workByOperation: Map<string, MonitoringWork>,
  elementCountByWorkIdentity: Map<string, number>,
  identifierKeys: readonly SystemIdentifierKey[],
): ScheduleGroupSummary {
  const works = node.operations.flatMap((operation) => {
    const work = workByOperation.get(operation.snapshotOperationId);
    return work ? [work] : [];
  });
  const statuses = works.map((work) => work.status);
  const percents = node.operations.flatMap((operation) =>
    operation.percentComplete === null ? [] : [operation.percentComplete]);
  const constructionStatus = !statuses.length
    ? null
    : statuses.every((status) => status.constructionStatus === "completed")
      ? "completed"
      : statuses.some((status) => status.constructionStatus === "in_progress" || status.constructionStatus === "completed")
        ? "in_progress"
        : statuses.every((status) => status.constructionStatus === "not_started")
          ? "not_started"
          : "diagnostic";
  const deviation = !statuses.length
    ? null
    : statuses.some((status) => status.deviation === "overdue")
      ? "overdue"
      : statuses.some((status) => status.deviation === "no_data")
        ? "no_data"
        : statuses.some((status) => status.deviation === "no_baseline")
          ? "no_baseline"
          : statuses.some((status) => status.deviation === "not_calculated")
            ? "not_calculated"
            : statuses.some((status) => status.deviation === "on_schedule")
              ? "on_schedule"
              : "ahead";
  const actualFinishes = node.operations.map((operation) => operation.actualFinish);
  const elementCount = [...new Set(node.operations.map((operation) =>
    scheduleWorkIdentity(operation, identifierKeys)))]
    .reduce((sum, identity) => sum + (elementCountByWorkIdentity.get(identity) ?? 0), 0);
  return {
    plannedStart: firstDate(node.operations.map((operation) => operation.start), "min"),
    plannedFinish: firstDate(node.operations.map((operation) => operation.finish), "max"),
    actualStart: firstDate(node.operations.map((operation) => operation.actualStart), "min"),
    actualFinish: firstDate(actualFinishes, "max"),
    actualFinishIsPartial: actualFinishes.some((value) => !value) && actualFinishes.some(Boolean),
    percentComplete: percents.length
      ? Math.round(percents.reduce((sum, value) => sum + value, 0) / percents.length)
      : null,
    constructionStatus,
    statusArea: statuses[0]?.area ?? null,
    deviation,
    elementCount,
  };
}

function GroupStatusCells({ summary, modelConnected }: { summary: ScheduleGroupSummary; modelConnected: boolean }) {
  return <>
    <td>{summary.constructionStatus
      ? <><span className={`status-badge status-${summary.constructionStatus}`}>{STATUS_LABELS[summary.constructionStatus]}</span>{summary.statusArea && <small className="table-note">{summary.statusArea === "fact" ? "Факт" : "План"}</small>}</>
      : "—"}</td>
    <td>{modelConnected ? <b>{summary.elementCount}</b> : "—"}</td>
  </>;
}
const STATUS_LABELS: Record<MonitoringWork["status"]["constructionStatus"], string> = {
  not_started: "Не начато",
  in_progress: "В работе",
  completed: "Завершено",
  diagnostic: "Нет данных",
};

function WorkStatusCells({ work }: { work: MonitoringWork | undefined; modelConnected: boolean }) {
  if (!work) return <><td>—</td><td>—</td></>;
  return <>
    <td><span className={`status-badge status-${work.status.constructionStatus}`} title={work.status.diagnostics.join(" ")}>{STATUS_LABELS[work.status.constructionStatus]}</span><small className="table-note">{work.status.area === "fact" ? "Факт" : "План"}</small></td>
    <td>—</td>
  </>;
}

function workRowClass(work: MonitoringWork | undefined, base = "") {
  return [base, "work-row", work ? `work-row-${work.status.deviation}` : ""].filter(Boolean).join(" ");
}

type ModelTreeNode = {
  id: string;
  label: string;
  depth: number;
  elementCount: number;
  groups: ModelWorkGroup[];
  children: ModelTreeNode[];
  group?: ModelWorkGroup;
};

type VisibleModelTreeRow =
  | { kind: "branch"; node: ModelTreeNode }
  | { kind: "work"; node: ModelTreeNode; group: ModelWorkGroup };

const MODEL_LOCATION_FIELDS = [
  { key: "building", label: "Корпус" },
  { key: "section", label: "Секция" },
  { key: "floor", label: "Этаж" },
] as const;

function buildModelWorkTree(
  groups: ModelWorkGroup[],
  modelId: BimModelId,
  identifierKeys: readonly SystemIdentifierKey[],
) {
  const fields = MODEL_LOCATION_FIELDS.filter(({ key }) =>
    identifierKeys.includes(key) && groups.some((group) => group[key]));
  const walk = (items: ModelWorkGroup[], depth: number, parentPath: string): ModelTreeNode[] => {
    if (depth >= fields.length) {
      return items.map((group) => ({
        id: `${parentPath}/work:${group.id}`,
        label: group.kfoName ? `${group.kfoCode} — ${group.kfoName}` : group.kfoCode,
        depth,
        elementCount: group.elementCount,
        groups: [group],
        children: [],
        group,
      }));
    }
    const field = fields[depth];
    const buckets = new Map<string, ModelWorkGroup[]>();
    for (const group of items) {
      const value = group[field.key] ?? "Не указано";
      const bucket = buckets.get(value) ?? [];
      bucket.push(group);
      buckets.set(value, bucket);
    }
    return [...buckets.entries()]
      .sort(([left], [right]) => left === "Не указано" ? 1 : right === "Не указано" ? -1 : left.localeCompare(right, "ru", { numeric: true }))
      .map(([value, bucket]) => {
        const id = `${parentPath}/${field.key}:${value}`;
        return {
          id,
          label: value,
          depth,
          elementCount: bucket.reduce((sum, group) => sum + group.elementCount, 0),
          groups: bucket,
          children: walk(bucket, depth + 1, id),
        };
      });
  };
  return walk(groups, 0, modelId);
}

function visibleModelTreeRows(nodes: ModelTreeNode[], collapsed: Set<string>): VisibleModelTreeRow[] {
  const rows: VisibleModelTreeRow[] = [];
  for (const node of nodes) {
    if (node.group) {
      rows.push({ kind: "work", node, group: node.group });
      continue;
    }
    rows.push({ kind: "branch", node });
    if (!collapsed.has(node.id)) rows.push(...visibleModelTreeRows(node.children, collapsed));
  }
  return rows;
}

function ModelWorkCards({ response, view, collapsed, toggleCollapsed, identifierKeys }: {
  response: ModelWorksResponse;
  view: "list" | "tree";
  collapsed: Set<string>;
  toggleCollapsed: (id: string) => void;
  identifierKeys: readonly SystemIdentifierKey[];
}) {
  return <div className="model-work-sources">{response.models.map((source) => {
    const model = BIM_MODELS.find((item) => item.id === source.modelId)!;
    const treeRows = visibleModelTreeRows(buildModelWorkTree(source.groups, source.modelId, identifierKeys), collapsed);
    return <section className="model-work-card" key={source.modelId}>
      <header>
        <div><span className="model-work-icon">◇</span><div><h2>{model.fileName}</h2><p>{source.elementCount.toLocaleString("ru-RU")} элементов · {source.groups.length.toLocaleString("ru-RU")} идентифицированных работ</p></div></div>
      </header>
      <div className="model-work-table-wrap"><table className="model-work-table"><thead><tr><th>Работа модели</th>{view === "list" && <th>Местоположение</th>}<th>В графике</th><th>Элементов</th></tr></thead>
        {view === "list" ? <tbody>
          {source.groups.map((group) => <tr className={group.scheduleOperationCount ? "" : "model-work-missing"} key={group.id}>
            <td><strong>{group.kfoName ? `${group.kfoCode} — ${group.kfoName}` : group.kfoCode}</strong></td>
            <td>{identifierKeys.filter((key) => key !== "kfo").map((key) => group[key]).filter(Boolean).join(" · ") || "Дополнительные идентификаторы выключены"}</td>
            <td>{group.scheduleOperationCount ? <span className="model-work-found">{group.scheduleOperationCount} опер.</span> : <span className="model-work-absent">Нет данных</span>}</td>
            <td className="model-element-count">{group.elementCount.toLocaleString("ru-RU")}</td>
          </tr>)}
          {source.unidentifiedElementCount > 0 && <tr className="model-work-unidentified"><td colSpan={3}><strong>Без идентификации работ</strong><small>В IFC не указан код КФО</small></td><td className="model-element-count">{source.unidentifiedElementCount.toLocaleString("ru-RU")}</td></tr>}
        </tbody> : <tbody>
          {treeRows.map((row) => row.kind === "branch" ? <tr className="model-tree-branch" key={row.node.id}>
            <td colSpan={2}><button type="button" style={{ paddingLeft: `${row.node.depth * 20}px` }} aria-expanded={!collapsed.has(row.node.id)} onClick={() => toggleCollapsed(row.node.id)}><span className={`css-chevron ${collapsed.has(row.node.id) ? "collapsed" : ""}`} /><strong>{row.node.label}</strong><span>{row.node.groups.length} работ</span></button></td>
            <td className="model-element-count">{row.node.elementCount.toLocaleString("ru-RU")}</td>
          </tr> : <tr className={row.group.scheduleOperationCount ? "" : "model-work-missing"} key={row.node.id}>
            <td style={{ paddingLeft: `${16 + row.node.depth * 20}px` }}><strong>{row.node.label}</strong></td>
            <td>{row.group.scheduleOperationCount ? <span className="model-work-found">{row.group.scheduleOperationCount} опер.</span> : <span className="model-work-absent">Нет данных</span>}</td>
            <td className="model-element-count">{row.group.elementCount.toLocaleString("ru-RU")}</td>
          </tr>)}
          {source.unidentifiedElementCount > 0 && <tr className="model-work-unidentified"><td colSpan={2}><strong>Без идентификации работ</strong><small>В IFC не указан код КФО</small></td><td className="model-element-count">{source.unidentifiedElementCount.toLocaleString("ru-RU")}</td></tr>}
        </tbody>}
      </table></div>
    </section>;
  })}</div>;
}

function Works({ scheduleId, operations, treeRows, version, monitoring, busy, modelConnected, activeModelId, selectedIfcModelIds, identifiers, graphControls, onImport, onConfigureModels }: { scheduleId: string; operations: SourceOperation[]; treeRows: ScheduleTreeRow[]; version: ScheduleVersionMetadata | null; monitoring: MonitoringSnapshot | null; busy: boolean; modelConnected: boolean; activeModelId: BimModelId; selectedIfcModelIds: BimModelId[]; identifiers: IdentifierDefinition[]; graphControls: ReactNode; onImport: () => void; onConfigureModels: () => void }) {
  const [source, setSource] = useState<"schedule" | "model">("schedule");
  const [view] = useState<"list" | "tree">("list");
  const [bimOnly, setBimOnly] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [collapsedTreeRows, setCollapsedTreeRows] = useState<Set<string>>(() => new Set());
  const [collapsedModelRows, setCollapsedModelRows] = useState<Set<string>>(() => new Set());
  const [modelWorks, setModelWorks] = useState<ModelWorksResponse | null>(null);
  const [modelWorksBusy, setModelWorksBusy] = useState(false);
  const [modelWorksError, setModelWorksError] = useState("");
  const identifierKeys = useMemo(() => activeIdentifierKeys(identifiers), [identifiers]);
  const identifierSignature = identifierKeys.join("|");
  const groupingLabel = identifierKeys.map((key) => identifiers.find((identifier) => identifier.key === key)?.label ?? key).join(" + ");
  const toggleGroup = (path: string) => setCollapsedGroups((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const toggleTreeRow = (rowId: string) => setCollapsedTreeRows((current) => {
    const next = new Set(current);
    if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
    return next;
  });
  const toggleModelRow = (rowId: string) => setCollapsedModelRows((current) => {
    const next = new Set(current);
    if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
    return next;
  });
  const linkedOperationIds = useMemo(() => new Set(
    monitoring?.modelWorks.flatMap((work) => work.operationIds) ?? [],
  ), [monitoring]);
  const displayedOperations = useMemo(() => bimOnly
    ? operations.filter((operation) => linkedOperationIds.has(operation.snapshotOperationId))
    : operations, [bimOnly, operations, linkedOperationIds]);
  const displayedTreeRows = useMemo(() => bimOnly
    ? treeRowsForOperationIds(treeRows, linkedOperationIds)
    : treeRows, [bimOnly, treeRows, linkedOperationIds]);
  const expandableTreeRows = useMemo(() => new Set(displayedTreeRows.flatMap((item, index) =>
    (displayedTreeRows[index + 1]?.outlineLevel ?? -1) > item.outlineLevel ? [item.rowId] : [],
  )), [displayedTreeRows]);
  const visibleTreeRows = useMemo(() => {
    const result: ScheduleTreeRow[] = [];
    let hiddenBelowLevel: number | null = null;
    for (const item of displayedTreeRows) {
      if (hiddenBelowLevel !== null && item.outlineLevel > hiddenBelowLevel) continue;
      hiddenBelowLevel = null;
      result.push(item);
      if (collapsedTreeRows.has(item.rowId)) hiddenBelowLevel = item.outlineLevel;
    }
    return result;
  }, [displayedTreeRows, collapsedTreeRows]);
  const groupNodes = useMemo(() => buildScheduleGroups(displayedOperations, identifierKeys), [displayedOperations, identifierSignature]);
  const listRows = useMemo(() => visibleGroupRows(groupNodes, collapsedGroups), [groupNodes, collapsedGroups]);
  const rootLevel = displayedTreeRows[0]?.outlineLevel ?? 0;
  const maxTreeLevel = Math.max(1, ...displayedTreeRows.map((item) => item.outlineLevel - rootLevel + 1));
  const showTreeLevel = (level: number) => setCollapsedTreeRows(collapsedRowsForLevel(displayedTreeRows, expandableTreeRows, rootLevel, level));
  const workByOperation = useMemo(() => new Map(monitoring?.works.map((work) => [work.operationId, work]) ?? []), [monitoring]);
  const elementCountByWorkIdentity = useMemo(() => new Map(
    monitoring?.modelWorks.map((work) => [work.workId, work.elementCount]) ?? [],
  ), [monitoring]);
  const activeModel = BIM_MODELS.find((item) => item.id === activeModelId)!;
  const visibleModelWorks = useMemo(() => modelWorks ? {
    ...modelWorks,
    models: modelWorks.models.filter((model) => selectedIfcModelIds.includes(model.modelId)),
  } : null, [modelWorks, selectedIfcModelIds.join("|")]);
  const modelWorkCount = visibleModelWorks?.models.reduce((sum, model) => sum + model.groups.length, 0) ?? 0;
  useEffect(() => {
    setCollapsedGroups(new Set());
    setCollapsedTreeRows(new Set());
    setCollapsedModelRows(new Set());
    setModelWorks(null);
  }, [version?.id, identifierSignature]);
  useEffect(() => {
    if (groupNodes.length) setCollapsedGroups(new Set(groupNodes.map((node) => node.path)));
  }, [version?.id, operations, identifierSignature]);
  useEffect(() => { if (!modelConnected) setBimOnly(false); }, [modelConnected]);
  useEffect(() => {
    if (source !== "model" || !modelConnected || !scheduleId || !version) return;
    const controller = new AbortController();
    setModelWorksBusy(true);
    setModelWorksError("");
    api<ModelWorksResponse>(`/api/schedules/${scheduleId}/versions/${version.id}/model-works`, { signal: controller.signal })
      .then(setModelWorks)
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setModelWorksError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setModelWorksBusy(false);
      });
    return () => controller.abort();
  }, [source, modelConnected, scheduleId, version?.id, identifierSignature, selectedIfcModelIds.join("|")]);
  if (!version) return <div className="workspace onboarding-workspace"><div className="empty onboarding-empty"><span>⇧</span><h2>Загрузите первый график</h2><p>Импортируйте XML, чтобы создать базовый график и перейти к работам.</p><button type="button" className="primary onboarding-import" onClick={onImport}>Импортировать график</button></div></div>;
  const bimFilter = <button type="button" className={`bim-filter-button ${bimOnly ? "active" : ""}`} disabled={!modelConnected || !monitoring} aria-pressed={bimOnly} title={!modelConnected ? "Сначала подключите BIM-модели" : "Показывать только работы, найденные и в графике, и в BIM-модели"} onClick={() => setBimOnly((current) => !current)}><span>С учетом BIM-данных</span>{modelConnected && <b>{linkedOperationIds.size}</b>}</button>;
  return <section className="workspace"><div className="page-title"><div className="works-heading"><div className="works-title-line"><h1>Работы</h1><div className="metric works-metric"><strong>{source === "schedule" ? displayedOperations.length.toLocaleString("ru-RU") : visibleModelWorks ? modelWorkCount.toLocaleString("ru-RU") : "—"}</strong><span>{source === "schedule" ? bimOnly ? `из ${version.cmrOperationCount.toLocaleString("ru-RU")} операций` : "операций" : modelConnected ? "работ из моделей" : "модели не выбраны"}</span></div></div><div className="works-source-row"><div className="works-source-switch" aria-label="Источник работ"><button type="button" className={source === "schedule" ? "active" : ""} onClick={() => setSource("schedule")}>График</button><button type="button" className={source === "model" ? "active" : ""} onClick={() => setSource("model")}>Модель</button></div><button type="button" className="context-import-button works-import-button" onClick={onImport}>Настроить данные</button></div>{source === "schedule" && modelConnected && <p className="model-path">Выбрано IFC: {selectedIfcModelIds.length} · основная: {activeModel.fileName}</p>}</div></div>
    {source === "schedule" && <div className="works-graph-controls">{graphControls}</div>}
    {source === "schedule" ? <>{view === "list" ? <div className="work-toolbar schedule-list-toolbar"><span className="toolbar-label">Состав работы</span><span className="fixed-grouping-label">{groupingLabel}</span><div className="grouping-bulk-actions"><button type="button" onClick={() => setCollapsedGroups(new Set(allGroupPaths(groupNodes)))}>Свернуть все</button><button type="button" onClick={() => setCollapsedGroups(new Set())}>Развернуть все</button></div>{bimFilter}</div>
      : <div className="work-toolbar tree-toolbar"><span className="toolbar-label">Уровни</span><div className="tree-level-buttons">{Array.from({ length: maxTreeLevel }, (_, index) => index + 1).map((level) => <button type="button" key={level} onClick={() => showTreeLevel(level)}>{level}</button>)}</div><div className="toolbar-separator" /><button type="button" onClick={() => setCollapsedTreeRows(new Set(expandableTreeRows))}>Свернуть всё</button><button type="button" onClick={() => setCollapsedTreeRows(new Set())}>Развернуть всё</button>{bimFilter}</div>}
    {busy ? <Empty text="Читаю версию…" /> : <div className="table-wrap"><table className="schedule-table"><thead><tr><th>Работа</th><th>Кол-во операций</th><th>Плановое начало</th><th>Плановое окончание</th><th>Фактическое начало</th><th>Фактическое окончание</th><th>Статус СМР</th><th>IFC</th></tr></thead>
      {view === "list" ? <tbody>{listRows.map((row) => {
        if (row.kind === "operation") {
          return <tr className={workRowClass(workByOperation.get(row.operation.snapshotOperationId))} key={row.operation.snapshotOperationId}><td style={{ paddingLeft: `${12 + row.depth * 20}px` }}>{row.operation.name}</td><td>—</td><td>{row.operation.start?.slice(0, 10) ?? "—"}</td><td>{row.operation.finish?.slice(0, 10) ?? "—"}</td><td>{row.operation.actualStart?.slice(0, 10) ?? "—"}</td><td>{row.operation.actualFinish?.slice(0, 10) ?? "—"}</td><WorkStatusCells work={workByOperation.get(row.operation.snapshotOperationId)} modelConnected={modelConnected} /></tr>;
        }
        const summary = summarizeScheduleGroup(row.node, workByOperation, elementCountByWorkIdentity, identifierKeys);
        return <tr className={`group-row ${summary.deviation ? `work-row-${summary.deviation}` : ""}`} key={row.node.path}>
          <td><button className="group-toggle" style={{ paddingLeft: `${row.node.depth * 20}px` }} type="button" aria-expanded={!collapsedGroups.has(row.node.path)} onClick={() => toggleGroup(row.node.path)}><span className={`css-chevron ${collapsedGroups.has(row.node.path) ? "collapsed" : ""}`} /><strong>{row.node.label}</strong></button></td>
          <td className="operation-count">{row.node.operations.length}</td>
          <td>{summary.plannedStart?.slice(0, 10) ?? "—"}</td>
          <td>{summary.plannedFinish?.slice(0, 10) ?? "—"}</td>
          <td>{summary.actualStart?.slice(0, 10) ?? "—"}</td>
          <td title={summary.actualFinishIsPartial ? "Дата есть только у части операций" : undefined}>{summary.actualFinish?.slice(0, 10) ?? "—"}{summary.actualFinishIsPartial && <small className="table-note">частично</small>}</td>
          <GroupStatusCells summary={summary} modelConnected={modelConnected} />
        </tr>;
      })}</tbody> : <tbody>{visibleTreeRows.map((item) => {
        const expandable = expandableTreeRows.has(item.rowId);
        const collapsed = collapsedTreeRows.has(item.rowId);
        return <tr className={item.isSummary ? "tree-summary-row" : workRowClass(workByOperation.get(item.rowId), "tree-operation-row")} key={item.rowId}><td><div className="tree-cell" style={{ paddingLeft: `${Math.max(0, item.outlineLevel - rootLevel) * 22}px` }}>{expandable ? <button className="tree-toggle" type="button" aria-label={collapsed ? "Развернуть" : "Свернуть"} aria-expanded={!collapsed} onClick={() => toggleTreeRow(item.rowId)}><span className={`css-chevron ${collapsed ? "collapsed" : ""}`} /></button> : <span className="tree-spacer" />}{item.isMilestone && <span className="milestone-mark">◆</span>}<span>{item.name}</span></div></td><td>—</td><td>{item.start?.slice(0, 10) ?? "—"}</td><td>{item.finish?.slice(0, 10) ?? "—"}</td><td>{item.actualStart?.slice(0, 10) ?? "—"}</td><td>{item.actualFinish?.slice(0, 10) ?? "—"}</td>{item.isSummary ? <><td>—</td><td>—</td></> : <WorkStatusCells work={workByOperation.get(item.rowId)} modelConnected={modelConnected} />}</tr>;
      })}</tbody>}</table></div>}
    {bimOnly && !displayedOperations.length && <div className="bim-empty">Для выбранной версии графика не найдено однозначных связей с BIM-моделью.</div>}</> : !modelConnected ? <div className="model-connection-empty"><span className="model-connection-icon">◇</span><h2>IFC-модели не выбраны</h2><p>Откройте единый мастер данных и выберите IFC-файлы, которые нужно использовать в модуле.</p><button type="button" className="primary" onClick={onConfigureModels}>Выбрать IFC</button></div> : <>
      <div className="work-toolbar model-source-toolbar"><span className="toolbar-label">Источник</span><strong>{selectedIfcModelIds.length} IFC-моделей</strong><button type="button" className="manage-ifc-button" onClick={onConfigureModels}>Изменить выбор</button><span className="model-source-hint">Красным отмечены работы, которых нет в выбранном графике</span></div>
      {modelWorksBusy ? <Empty text="Собираю работы из моделей…" /> : modelWorksError ? <div className="bim-empty">{modelWorksError}</div> : visibleModelWorks ? <ModelWorkCards response={visibleModelWorks} view={view} collapsed={collapsedModelRows} toggleCollapsed={toggleModelRow} identifierKeys={identifierKeys} /> : <Empty text="Подготавливаю выбранные модели…" />}
    </>}
  </section>;
}

function IfcModelSelector({ selectedIds, activeModelId, onSelectedIdsChange, onActiveModelIdChange }: {
  selectedIds: BimModelId[];
  activeModelId: BimModelId;
  onSelectedIdsChange: (ids: BimModelId[]) => void;
  onActiveModelIdChange: (id: BimModelId) => void;
}) {
  const [search, setSearch] = useState("");
  const filteredModels = BIM_MODELS.filter((model) =>
    `${model.fileName} ${model.title} ${model.description} ${IFC_MODEL_META[model.id].discipline} ${IFC_MODEL_META[model.id].scope}`
      .toLocaleLowerCase("ru").includes(search.trim().toLocaleLowerCase("ru")));

  function toggle(modelId: BimModelId) {
    const next = selectedIds.includes(modelId)
      ? selectedIds.filter((id) => id !== modelId)
      : [...selectedIds, modelId];
    onSelectedIdsChange(next);
    if (next.length && !next.includes(activeModelId)) onActiveModelIdChange(next.at(-1)!);
  }

  return <div className="ifc-workspace wizard-ifc-workspace"><aside className="ifc-catalog"><label className="ifc-search"><span>Все IFC-модели</span><input type="search" value={search} placeholder="Название, раздел или область" onChange={(event) => setSearch(event.target.value)} /></label><div className="ifc-list">{filteredModels.map((model) => {
    const selected = selectedIds.includes(model.id);
    return <label className={`ifc-option ${selected ? "selected" : ""}`} key={model.id}><input type="checkbox" checked={selected} onChange={() => toggle(model.id)} /><span className="ifc-check">{selected ? "✓" : ""}</span><span className="ifc-option-copy"><strong>{model.fileName}</strong><small>{model.title} · {IFC_MODEL_META[model.id].discipline}</small><small>{model.description}</small></span><b>{model.sizeLabel}</b></label>;
  })}{!filteredModels.length && <div className="ifc-no-results">Ничего не найдено</div>}</div></aside>
    <section className="ifc-selection-pane"><header><div><span className="eyebrow">Состав выбора</span><h3>Выбранные IFC-модели</h3></div><span>{selectedIds.length}</span></header>{selectedIds.length ? <div className="ifc-table-wrap"><table className="ifc-selection-table"><thead><tr><th>IFC-модель</th><th>Версия</th><th>Раздел</th><th>Область</th><th>Основная</th></tr></thead><tbody>{selectedIds.map((modelId) => {
      const model = BIM_MODELS.find((item) => item.id === modelId)!;
      return <tr className={activeModelId === modelId ? "active" : ""} key={model.id}><td><strong>{model.fileName}</strong><small>{model.sizeLabel}</small></td><td>{model.title}</td><td>{IFC_MODEL_META[model.id].discipline}</td><td>{IFC_MODEL_META[model.id].scope}</td><td><label className="viewer-model-choice"><input type="radio" name="activeIfcModel" checked={activeModelId === model.id} onChange={() => onActiveModelIdChange(model.id)} /><span>{activeModelId === model.id ? "Основная" : "Выбрать"}</span></label></td></tr>;
    })}</tbody></table></div> : <div className="ifc-selection-empty"><span>◇</span><p>Выберите один или несколько IFC-файлов слева.</p></div>}</section>
  </div>;
}

function Settings({ identifiers, loading, version, statusDate, savingVersion, onStatusDateChange, onIdentifiersChange }: {
  identifiers: IdentifierDefinition[];
  loading: boolean;
  version: ScheduleVersionMetadata | null;
  statusDate: string;
  savingVersion: boolean;
  onStatusDateChange: (value: string) => void;
  onIdentifiersChange: (identifiers: IdentifierDefinition[]) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [dialog, setDialog] = useState<"attributes" | "values" | null>(null);
  const [selectedKey, setSelectedKey] = useState("kfo");
  const [master, setMaster] = useState<"attributes" | "values">("attributes");
  const [draftAttributes, setDraftAttributes] = useState<string[]>([]);
  const [draftAliases, setDraftAliases] = useState<Record<string, string[]>>({});
  const [activeValue, setActiveValue] = useState("");
  const selectedIdentifier = identifiers.find((identifier) => identifier.key === selectedKey) ?? null;
  const systemIdentifiers = identifiers.filter((identifier) => isSystemIdentifierKey(identifier.key));
  const activeCount = activeIdentifierKeys(identifiers).length;

  async function persistIdentifiers(next: IdentifierDefinition[]) {
    setSaving(true);
    setSettingsMessage("");
    try {
      const saved = await api<{ identifiers: IdentifierDefinition[] }>("/api/settings/identifiers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers: next }),
      });
      onIdentifiersChange(saved.identifiers);
      setSettingsMessage("Настройки сохранены. IFC-сопоставление будет пересчитано.");
      return true;
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Не удалось сохранить настройки.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function closeDialog() {
    setDialog(null);
    setSelectedKey("");
  }

  function openAttributesDialog(identifier: IdentifierDefinition) {
    setSelectedKey(identifier.key);
    setDraftAttributes([...identifier.attributes]);
    setDialog("attributes");
  }

  function openValuesDialog(identifier: IdentifierDefinition) {
    setSelectedKey(identifier.key);
    setDraftAliases(Object.fromEntries(identifier.values.map((value) => [value, [...(identifier.valueAliases[value] ?? [value])]])));
    setActiveValue(identifier.values[0] ?? "");
    setDialog("values");
  }

  async function toggleIdentifier(identifier: IdentifierDefinition) {
    if (identifier.key === "kfo") return;
    await persistIdentifiers(identifiers.map((item) => item.key === identifier.key
      ? { ...item, isActive: !item.isActive }
      : item));
  }

  async function saveAttributes() {
    if (!selectedIdentifier) return;
    const attributes = [...new Set(draftAttributes.map((value) => value.trim()).filter(Boolean))];
    const next = identifiers.map((identifier) => identifier.key === selectedIdentifier.key
      ? { ...identifier, attributes }
      : identifier);
    if (await persistIdentifiers(next)) closeDialog();
  }

  async function saveAliases() {
    if (!selectedIdentifier) return;
    const valueAliases = Object.fromEntries(selectedIdentifier.values.map((value) => [
      value,
      [...new Set((draftAliases[value] ?? []).map((alias) => alias.trim()).filter(Boolean))],
    ]));
    const next = identifiers.map((identifier) => identifier.key === selectedIdentifier.key
      ? { ...identifier, valueAliases }
      : identifier);
    if (await persistIdentifiers(next)) closeDialog();
  }

  const activeAliases = activeValue ? draftAliases[activeValue] ?? [] : [];

  return <section className="workspace settings-page">
    <div className="page-title settings-title"><div><h1>Настройки работ</h1><p>Отчётная дата версии и единый состав идентификаторов для всего модуля</p></div><div className="settings-state"><span>{activeCount} из 4 идентификаторов активно</span><strong>{saving || savingVersion ? "Сохраняю…" : "Настройки синхронизированы"}</strong></div></div>
    {settingsMessage && <div className="bim-empty">{settingsMessage}</div>}
    <div className="work-settings-overview">
      <article className="report-date-card"><div><span className="eyebrow">Выбранная версия</span><h2>Отчётная дата</h2><p>{version ? `${formatVersionOption(version)} · ${version.originalFileName}` : "Сначала импортируйте базовый график"}</p></div><label><span>Дата версии</span><input type="date" value={statusDate} disabled={!version} onChange={(event) => onStatusDateChange(event.target.value)} /><small>{!version ? "Нет выбранной версии" : savingVersion ? "Сохраняю…" : statusDate !== version.effectiveStatusDate ? "Автосохранение через 5 секунд" : "Сохранено"}</small></label></article>
      <article className="identity-scope-card"><span className="eyebrow">Область действия</span><h2>Идентификаторы работ</h2><p>Активный набор применяется к спискам, группам работ, графикам мониторинга и BIM-сопоставлению.</p><div className="active-identifier-pills">{systemIdentifiers.filter((identifier) => identifier.isActive).map((identifier) => <span key={identifier.key}>{identifier.label}</span>)}</div></article>
    </div>
    <div className="settings-content"><section className="identifier-master">
      <aside className="identifier-master-list"><header><span className="eyebrow">Уровни работ</span><h2>Идентификаторы</h2><p>КФО обязателен. Остальные уровни включаются независимо.</p></header>{systemIdentifiers.map((identifier) => <div className={`identifier-nav-row ${selectedKey === identifier.key ? "selected" : ""} ${identifier.isActive ? "active" : ""}`} key={identifier.key}>
        <button type="button" className="identifier-nav-main" onClick={() => setSelectedKey(identifier.key)}><span className="identifier-icon">#</span><span><strong>{identifier.label}</strong><small>{identifier.description}</small></span></button>
        <label className="identifier-switch" title={identifier.key === "kfo" ? "Обязательный идентификатор" : identifier.isActive ? "Выключить идентификатор" : "Включить идентификатор"}><input type="checkbox" checked={identifier.isActive} disabled={loading || saving || identifier.key === "kfo"} onChange={() => void toggleIdentifier(identifier)} /><span /></label>
      </div>)}</aside>
      <div className="identifier-master-pane">{selectedIdentifier ? <><header><div><span className="eyebrow">{selectedIdentifier.isActive ? "Используется в работах" : "Не участвует в расчёте"}</span><h2>{selectedIdentifier.label}</h2><p>{selectedIdentifier.description}</p></div><span className={`scope-badge ${selectedIdentifier.isActive ? "active" : ""}`}>{selectedIdentifier.key === "kfo" ? "Обязательный" : selectedIdentifier.isActive ? "Включён" : "Выключен"}</span></header>
        <div className="master-tabs"><button type="button" className={master === "attributes" ? "active" : ""} onClick={() => setMaster("attributes")}><span>01</span> Мастер атрибутов</button><button type="button" className={master === "values" ? "active" : ""} onClick={() => setMaster("values")}><span>02</span> Мастер значений</button></div>
        {master === "attributes" ? <div className="master-screen"><div className="master-screen-head"><div><h3>Где искать значение</h3><p>Параметры проверяются сверху вниз; используется первое заполненное значение.</p></div><button type="button" disabled={saving} onClick={() => openAttributesDialog(selectedIdentifier)}>Изменить список</button></div><ol className="attribute-preview">{selectedIdentifier.attributes.map((attribute) => <li key={attribute}><span>{attribute}</span></li>)}</ol></div>
          : <div className="master-screen"><div className="master-screen-head"><div><h3>Как приводить значения</h3><p>Каждое системное значение объединяет допустимые варианты из XML, XLSX и IFC.</p></div><button type="button" disabled={saving} onClick={() => openValuesDialog(selectedIdentifier)}>Настроить маппинг</button></div><div className="value-preview-grid">{selectedIdentifier.values.map((value) => <article key={value}><strong>{value}</strong><span>{selectedIdentifier.valueAliases[value]?.length ?? 0} вариантов источника</span></article>)}</div></div>}
      </> : <Empty text="Выберите идентификатор" />}</div>
    </section></div>

    {dialog === "attributes" && selectedIdentifier && <div className="modal-backdrop" role="presentation" onMouseDown={closeDialog}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="attributes-title" onMouseDown={(event) => event.stopPropagation()}>
      <button className="modal-close" type="button" aria-label="Закрыть" onClick={closeDialog}>×</button>
      <span className="eyebrow">Мастер атрибутов</span><h2 id="attributes-title">Где искать «{selectedIdentifier.label}»</h2><p>Перечислите названия параметров модели или файла. Система проверит их по порядку и возьмёт первое заполненное значение.</p>
      <div className="dialog-list-heading"><span>Названия параметров</span><small>{draftAttributes.filter((value) => value.trim()).length}</small></div>
      <div className="editable-list parameter-list">{draftAttributes.map((value, index) => <div className="editable-row" key={index}><span className="drag-mark">⋮⋮</span><input value={value} placeholder="Название параметра" onChange={(event) => setDraftAttributes((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} /><button type="button" aria-label="Удалить параметр" onClick={() => setDraftAttributes((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}</div>
      <button className="add-list-item" type="button" onClick={() => setDraftAttributes((current) => [...current, ""])}>＋ Добавить параметр</button>
      <div className="mapping-example"><span>Пример</span><code>ADSK_Этаж</code><i>→</i><strong>Этаж</strong></div>
      {settingsMessage && <div className="bim-empty">{settingsMessage}</div>}
      <div className="modal-actions"><button type="button" disabled={saving} onClick={closeDialog}>Отмена</button><button type="button" className="primary" disabled={saving} onClick={() => void saveAttributes()}>{saving ? "Сохраняю…" : "Сохранить"}</button></div>
    </section></div>}

    {dialog === "values" && selectedIdentifier && <div className="modal-backdrop" role="presentation" onMouseDown={closeDialog}><section className="settings-dialog value-mapping-dialog" role="dialog" aria-modal="true" aria-labelledby="values-title" onMouseDown={(event) => event.stopPropagation()}>
      <button className="modal-close" type="button" aria-label="Закрыть" onClick={closeDialog}>×</button>
      <span className="eyebrow">Мастер значений</span><h2 id="values-title">Маппинг значений «{selectedIdentifier.label}»</h2><p>Для каждого значения в системе задайте варианты, которые могут встретиться в параметрах модели, XML или XLSX.</p>
      <div className="value-mapping-workspace"><aside><span>Значение в системе</span>{selectedIdentifier.values.map((value) => <button type="button" className={activeValue === value ? "active" : ""} key={value} onClick={() => setActiveValue(value)}><strong>{value}</strong><small>{draftAliases[value]?.length ?? 0}</small></button>)}</aside><div className="value-alias-editor"><div className="canonical-value"><span>В системе</span><strong>{activeValue}</strong></div><div className="dialog-list-heading"><span>Допустимые значения в источнике</span><small>{activeAliases.filter((value) => value.trim()).length}</small></div><div className="editable-list alias-list">{activeAliases.map((alias, index) => <div className="editable-row" key={`${activeValue}-${index}`}><input value={alias} placeholder="Например, Этаж_01" onChange={(event) => setDraftAliases((current) => ({ ...current, [activeValue]: current[activeValue].map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} /><button type="button" aria-label="Удалить вариант" onClick={() => setDraftAliases((current) => ({ ...current, [activeValue]: current[activeValue].filter((_, itemIndex) => itemIndex !== index) }))}>×</button></div>)}</div><button className="add-list-item" type="button" onClick={() => setDraftAliases((current) => ({ ...current, [activeValue]: [...(current[activeValue] ?? []), ""] }))}>＋ Добавить вариант</button><div className="mapping-example value-example"><span>Если найдено</span><code>{activeAliases.find((alias) => alias !== activeValue) ?? activeValue}</code><i>→</i><strong>{activeValue}</strong></div></div></div>
      {settingsMessage && <div className="bim-empty">{settingsMessage}</div>}
      <div className="modal-actions"><button type="button" disabled={saving} onClick={closeDialog}>Отмена</button><button type="button" className="primary" disabled={saving} onClick={() => void saveAliases()}>{saving ? "Сохраняю…" : "Сохранить"}</button></div>
    </section></div>}
  </section>;
}

function ImportForm({ schedule, hasSchedules, identifiers, selectedIfcModelIds, activeModelId, initialStep, mode, busy, submit, applyConfiguration, close }: {
  schedule: ProjectSchedule | null;
  hasSchedules: boolean;
  identifiers: IdentifierDefinition[];
  selectedIfcModelIds: BimModelId[];
  activeModelId: BimModelId;
  initialStep: number;
  mode: ImportWizardMode;
  busy: boolean;
  submit: (configuration: ImportConfiguration) => Promise<void>;
  applyConfiguration: (selectedKeys: SystemIdentifierKey[], ifcModelIds: BimModelId[], modelId: BimModelId) => Promise<void>;
  close: () => void;
}) {
  const firstImport = !hasSchedules;
  const baselines = schedule?.versions.filter((item) => item.kind === "baseline") ?? [];
  const [step, setStep] = useState(Math.min(3, Math.max(mode === "configure" ? 2 : 1, initialStep)));
  const [kind, setKind] = useState<"baseline" | "operational">(firstImport ? "baseline" : baselines.length ? "operational" : "baseline");
  const [baselineVersionId, setBaselineVersionId] = useState(baselines[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [statusDate, setStatusDate] = useState("");
  const [fileMessage, setFileMessage] = useState("Дата будет прочитана после выбора XML");
  const [selectedKeys, setSelectedKeys] = useState<SystemIdentifierKey[]>(() => activeIdentifierKeys(identifiers));
  const [ifcModelIds, setIfcModelIds] = useState<BimModelId[]>(selectedIfcModelIds);
  const [draftModelId, setDraftModelId] = useState<BimModelId>(activeModelId);

  useEffect(() => { setSelectedKeys(activeIdentifierKeys(identifiers)); }, [identifiers]);

  async function inspectSelectedFile(selectedFile: File | undefined) {
    setFile(selectedFile ?? null);
    if (!selectedFile) {
      setStatusDate("");
      setFileMessage("Дата будет прочитана после выбора XML");
      return;
    }
    try {
      const document = new DOMParser().parseFromString(await selectedFile.text(), "application/xml");
      if (document.querySelector("parsererror")) throw new Error("XML не удалось прочитать");
      const statusNode = [...document.getElementsByTagName("*")].find((node) => node.localName === "StatusDate");
      const sourceDate = statusNode?.textContent?.trim().slice(0, 10) ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) {
        const fallback = new Date().toISOString().slice(0, 10);
        setStatusDate(fallback);
        setFileMessage(`В XML нет Project/StatusDate — подставлена текущая дата ${formatDisplayDate(fallback)}`);
        return;
      }
      setStatusDate(sourceDate);
      setFileMessage(`Прочитана из Project/StatusDate: ${formatDisplayDate(sourceDate)}`);
    } catch (error) {
      setStatusDate("");
      setFileMessage(error instanceof Error ? error.message : "XML не удалось прочитать");
    }
  }

  function toggleIdentifier(key: SystemIdentifierKey) {
    if (key === "kfo") return;
    setSelectedKeys((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key]);
  }

  const canSubmitImport = Boolean(file && statusDate && (kind === "baseline" || baselineVersionId));
  const steps = [
    { number: 1, label: "График", summary: file ? file.name : firstImport ? "Базовый · XML не выбран" : `${kind === "baseline" ? "Базовый" : "Операционный"} · XML не выбран` },
    { number: 2, label: "IFC-модели", summary: ifcModelIds.length ? `${ifcModelIds.length} выбрано` : "Не выбраны" },
    { number: 3, label: "Идентификаторы", summary: `${selectedKeys.length} активно` },
  ];
  const saveLabel = step === 1
    ? firstImport ? "Создать график" : "Импортировать график"
    : step === 2
      ? "Сохранить модели"
      : "Пересчитать работы";

  async function finish() {
    if (step !== 1) {
      await applyConfiguration(selectedKeys, ifcModelIds, draftModelId);
      return;
    }
    if (!file || !canSubmitImport) return;
    await submit({
      file,
      kind,
      baselineVersionId,
      effectiveStatusDate: statusDate,
      identifierKeys: selectedKeys,
      ifcModelIds,
      activeModelId: draftModelId,
    });
  }

  return <div className="import-backdrop"><section className="import-card import-wizard" role="dialog" aria-modal="true" aria-labelledby="import-title">
    <button className="modal-close" type="button" aria-label="Закрыть мастер" onClick={close}>×</button>
    <header className="import-heading wizard-heading"><div><span className="eyebrow">Работы и модели</span><h1 id="import-title">Настройка данных</h1><p>Выберите раздел слева. Каждый раздел изменяется и сохраняется независимо.</p></div><span className="wizard-progress">3 раздела</span></header>
    <div className="import-wizard-body"><aside className="wizard-steps">{steps.map((item) => {
      return <button type="button" className={step === item.number ? "active" : ""} key={item.number} onClick={() => setStep(item.number)}><span>{String(item.number).padStart(2, "0")}</span><span><strong>{item.label}</strong><small>{item.summary}</small></span></button>;
    })}</aside><section className="wizard-panel">
      {step === 1 && <div className="wizard-step-screen"><header><span className="eyebrow">График</span><h2>XML и отчётная дата</h2></header><div className="wizard-schedule-stack">{firstImport ? <div className="locked-schedule-kind"><span>◆</span><div><strong>Базовый график</strong><small>Стартовая договорная версия</small></div><b>Выбрано</b></div> : <div className="wizard-fields"><label>Тип графика<select value={kind} onChange={(event) => setKind(event.target.value as "baseline" | "operational")}><option value="baseline">Базовый график</option><option value="operational" disabled={!baselines.length}>Операционный график</option></select></label>{kind === "operational" && <label>Связать с базовой версией<select value={baselineVersionId} onChange={(event) => setBaselineVersionId(event.target.value)}><option value="">Выберите базовую версию</option>{baselines.map((item) => <option key={item.id} value={item.id}>Базовый · {item.effectiveStatusDate} · {item.originalFileName}</option>)}</select></label>}</div>}<div className="wizard-file-grid"><label className={`file-drop ${file ? "selected" : ""}`}><span className="file-drop-icon">⇧</span><span><strong>{file?.name || "Выберите XML-файл"}</strong><small>{file ? "Файл готов к обработке" : "Нажмите для выбора файла"}</small></span><input type="file" accept=".xml,text/xml,application/xml" onChange={(event) => void inspectSelectedFile(event.target.files?.[0])} /></label><label className="report-date-import"><span className="report-date-label">Отчётная дата</span><input type="date" value={statusDate} onChange={(event) => setStatusDate(event.target.value)} /><small className="field-help">{fileMessage}</small></label></div></div></div>}
      {step === 2 && <div className="wizard-step-screen wizard-model-step"><header><div><span className="eyebrow">IFC-модели</span><h2>Выбор моделей проекта</h2></div><span className="wizard-optional">Сохраняется отдельно</span></header><IfcModelSelector selectedIds={ifcModelIds} activeModelId={draftModelId} onSelectedIdsChange={setIfcModelIds} onActiveModelIdChange={setDraftModelId} /></div>}
      {step === 3 && <div className="wizard-step-screen"><header><span className="eyebrow">Идентификаторы</span><h2>Состав работ текущей версии</h2></header><div className="wizard-identifiers">{identifiers.filter((identifier) => isSystemIdentifierKey(identifier.key)).map((identifier) => {
        const key = identifier.key as SystemIdentifierKey;
        const active = key === "kfo" || selectedKeys.includes(key);
        return <button type="button" className={active ? "active" : ""} aria-pressed={active} disabled={key === "kfo"} key={key} onClick={() => toggleIdentifier(key)}><span className="identifier-cube">{active ? "✓" : "+"}</span><span><strong>{identifier.label}</strong><small>{key === "kfo" ? "Обязательный" : active ? "Участвует в формировании работ" : "Добавить идентификатор"}</small></span></button>;
      })}</div><div className="wizard-result-summary"><span>Будет сформировано</span><strong>{selectedKeys.map((key) => identifiers.find((identifier) => identifier.key === key)?.label ?? key).join(" → ")}</strong><small>{ifcModelIds.length ? `${ifcModelIds.length} IFC-моделей` : "Без BIM-связи"}</small></div></div>}
    </section></div>
    <footer className="import-actions wizard-actions"><button type="button" onClick={close}>Отмена</button><span /> <button type="button" className="primary" disabled={busy || (step === 1 && !canSubmitImport)} onClick={() => void finish()}>{busy ? "Обрабатываю…" : saveLabel}</button></footer>
  </section></div>;
}
function Empty({ text }: { text: string }) { return <div className="empty"><span>○</span><p>{text}</p></div>; }


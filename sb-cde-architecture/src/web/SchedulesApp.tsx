import SchedulesPage from "./SchedulesPage";

export default function SchedulesApp() {
  return (
    <div className="shell schedule-shell">
      <header>
        <div className="brand-mark schedule-brand-mark" aria-hidden="true">
          SB
        </div>
        <div className="brand">
          <strong>ГВР</strong>
          <span>График выполнения работ · локальный рабочий модуль</span>
        </div>
        <div className="surface-context">
          Единственный тип графика · базовые и операционные версии
        </div>
        <div className="revision">
          Локальные источники
          <span className="readonly">Источник сохраняется</span>
        </div>
      </header>
      <SchedulesPage />
      <footer>
        <span>ГВР</span>
        <span>Б/О версии · исходные операции · таблица · дерево</span>
        <span>Каждая версия хранит неизменяемый XML</span>
      </footer>
    </div>
  );
}

export type StatusModel = "execution" | "problems" | "construction";

export type FilterableDisplayState =
  | "context"
  | "completed"
  | "inProgress"
  | "diagnostic"
  | "overdue"
  | "onSchedule"
  | "ahead"
  | "unknown"
  | "builtActual"
  | "builtPlan"
  | "notBuilt";

type LegendItem = {
  state: FilterableDisplayState;
  className: string;
  label: string;
};

const ITEMS: Record<StatusModel, LegendItem[]> = {
  execution: [
    { state: "completed", className: "completed", label: "Завершено" },
    { state: "inProgress", className: "progress", label: "В работе" },
    { state: "context", className: "context", label: "Не начато" },
    { state: "diagnostic", className: "diagnostic", label: "Требует данных" },
  ],
  problems: [
    { state: "overdue", className: "overdue", label: "Просрочка" },
    { state: "onSchedule", className: "on-schedule", label: "По графику" },
    { state: "ahead", className: "ahead", label: "Опережение" },
    { state: "unknown", className: "unknown", label: "Нет расчёта" },
  ],
  construction: [
    { state: "builtActual", className: "built-actual", label: "Возведено по факту" },
    { state: "builtPlan", className: "built-plan", label: "Возведено по плану" },
    { state: "notBuilt", className: "hidden", label: "Ещё не возведено" },
  ],
};

export function IfcStatusLegend({
  statusModel,
  hiddenStates,
  onToggle,
}: {
  statusModel: StatusModel;
  hiddenStates: ReadonlySet<FilterableDisplayState>;
  onToggle: (state: FilterableDisplayState) => void;
}) {
  return <>
    {statusModel === "problems" && <small className="status-model-note">Отклонение по срокам от базового графика</small>}
    {statusModel === "construction" && <small className="status-model-note">Накопительное возведение на выбранную дату</small>}
    <div className="ifc-legend">
      {ITEMS[statusModel].map((item) => {
        const visible = !hiddenStates.has(item.state);
        return <button
          className={`ifc-legend-card ${item.className}${visible ? "" : " is-hidden"}`}
          type="button"
          aria-pressed={visible}
          title={`${visible ? "Скрыть" : "Показать"}: ${item.label.toLocaleLowerCase("ru")}`}
          key={item.state}
          onClick={() => onToggle(item.state)}
        ><i />{item.label}</button>;
      })}
    </div>
  </>;
}

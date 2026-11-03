import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import ArchitectureApp from "./App";
import ProductShell from "./ProductShell";
import SchedulesApp from "./SchedulesApp";
import "./styles.css";
import "./graph-theme.css";

const path = window.location.pathname.replace(/\/+$/, "") || "/";
const IfcViewer = lazy(() => import("./IfcViewer"));
const isArchitectureRoute =
  path === "/architecture" || path.startsWith("/architecture/");
const isIfcRoute = path === "/ifc" || path.startsWith("/ifc/");
const activeProduct = isArchitectureRoute ? "map" : isIfcRoute ? "ifc" : "schedules";
document.title = isArchitectureRoute
  ? "Архитектурная карта · КСУП BIM"
  : isIfcRoute
    ? "Мониторинг объекта · КСУП BIM"
    : "ГВР · КСУП BIM";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ProductShell active={activeProduct}>
      {isArchitectureRoute ? (
        <ArchitectureApp />
      ) : isIfcRoute ? (
        <Suspense fallback={<div className="route-loading">Загружаем мониторинг объекта…</div>}>
          <IfcViewer />
        </Suspense>
      ) : (
        <SchedulesApp />
      )}
    </ProductShell>
  </StrictMode>,
);

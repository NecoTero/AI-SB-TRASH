import type { ReactNode } from "react";

type ProductShellProps = {
  active: "map" | "schedules" | "ifc";
  children: ReactNode;
};

const platformSections = [
  "Документация",
  "Замечания",
  "Согласования",
  "MIDP",
  "MDR",
  "BIM",
  "Объёмы",
  "Настройки",
  "Реестр документов",
  "Передачи",
  "Участники",
] as const;

const bimItems = [
  { id: "ifc", href: "/ifc", label: "Мониторинг объекта", icon: CubeIcon },
  { id: "schedules", href: "/", label: "ГВР", icon: ChartIcon },
  { id: "map", href: "/architecture", label: "Архитектурная карта", icon: MapIcon },
] as const;

export default function ProductShell({ active, children }: ProductShellProps) {
  return (
    <div className="product-shell">
      <header className="platform-header">
        <div className="platform-brand" aria-label="КСУП BIM">
          <span>КСУП</span>
          <b>BIM</b>
        </div>
        <a className="projects-link" href="#projects" onClick={(event) => event.preventDefault()}>
          <ChevronLeftIcon />
          <span>К проектам</span>
        </a>
        <div className="platform-project">АГА02. Аэровокзал Горно-Алтайск</div>
        <div className="platform-account">
          <div className="account-building" aria-hidden="true"><BuildingIcon /></div>
          <span><small>Аккаунт</small><strong>Блок Строительство</strong></span>
          <ChevronDownIcon />
        </div>
        <div className="platform-tools" aria-label="Служебные действия">
          <button type="button" className="theme-control" aria-label="Тёмная тема включена" title="Тёмная тема"><MoonIcon /></button>
          <button type="button" aria-label="Справка" title="Справка"><HelpIcon /></button>
          <button type="button" className="notification-control" aria-label="Уведомления: 7" title="Уведомления"><BellIcon /><span>7</span></button>
          <div className="platform-avatar" aria-label="Профиль пользователя"><UserIcon /></div>
        </div>
      </header>

      <nav className="platform-tabs" aria-label="Разделы проекта">
        {platformSections.map((section) => (
          <a
            key={section}
            className={section === "BIM" ? "active" : ""}
            href={section === "BIM" ? "#bim" : "#"}
            aria-current={section === "BIM" ? "page" : undefined}
            onClick={(event) => event.preventDefault()}
          >
            {section}
          </a>
        ))}
      </nav>

      <div className="platform-workspace">
        <nav className="bim-tool-navigation" aria-label="Инструменты BIM">
          <span className="bim-tool-navigation__label">Инструменты</span>
          {bimItems.map((item) => {
            const Icon = item.icon;
            return (
              <a key={item.id} className={active === item.id ? "active" : ""} href={item.href} aria-current={active === item.id ? "page" : undefined}>
                <Icon />
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>
        <div className="product-surface">{children}</div>
      </div>
    </div>
  );
}

function MapIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="6" r="2.25" />
      <circle cx="18" cy="7" r="2.25" />
      <circle cx="12" cy="18" r="2.25" />
      <path d="M8 6.2l7.7.6M7.2 8l3.6 7.8M16.8 9l-3.5 6.8" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 19V5M4 19h16" />
      <path d="M7 15l3-4 3 2 5-6" />
      <circle cx="7" cy="15" r="1" />
      <circle cx="10" cy="11" r="1" />
      <circle cx="13" cy="13" r="1" />
      <circle cx="18" cy="7" r="1" />
    </svg>
  );
}

function CubeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M4.4 7.7L12 12l7.6-4.3M12 12v8.5" />
    </svg>
  );
}

function BuildingIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 21V5l5-2v18M12 7h5v14M4 21h16" />
      <path d="M9 7v1M9 11v1M9 15v1M15 10v1M15 14v1M15 18v1" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>;
}

function ChevronDownIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>;
}

function MoonIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.2A8 8 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" /></svg>;
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.7 9a2.5 2.5 0 0 1 4.7 1.2c0 2-2.4 2.1-2.4 4M12 18h.01" />
    </svg>
  );
}

function BellIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9.7 21h4.6" /></svg>;
}

function UserIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></svg>;
}

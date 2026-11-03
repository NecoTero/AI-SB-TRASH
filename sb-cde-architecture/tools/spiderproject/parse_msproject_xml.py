#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Детерминированный парсер Microsoft Project XML: таблица, БД и дерево.

Python >= 3.9. Обязательных внешних зависимостей нет.
Если доступен пакет artifact_tool, дополнительно формирует Excel (.xlsx).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

SCHEMA_VERSION = "1.0.0"
CORE_FIELDS = [
    "source_order", "uid", "id", "parent_uid", "task_name", "task_code", "work_code_pir",
    "wbs", "outline_number", "outline_level", "is_summary", "is_milestone",
    "project_code", "cbs_code", "cbs_name", "kfo_code", "kfo_name",
    "plan_start", "plan_finish", "actual_start", "actual_finish",
    "early_start", "early_finish", "late_start", "late_finish",
    "constraint_date", "deadline", "stop_date", "resume_date",
    "volume_plan", "volume_fact", "volume_cost", "percent_complete",
    "duration", "actual_duration", "remaining_duration", "calendar_uid", "nested_xml_json",
]
NAME_TO_CORE = {
    "Код проекта": "project_code",
    "Код CBS": "cbs_code",
    "CBS": "cbs_name",
    "Код КФО": "kfo_code",
    "КФО": "kfo_name",
    "Spider_Code": "task_code",
    "Код работ из раздела ПИР": "work_code_pir",
}
CORE_FROM_XML = {
    "uid": "UID", "id": "ID", "task_name": "Name", "wbs": "WBS",
    "outline_number": "OutlineNumber", "outline_level": "OutlineLevel",
    "is_summary": "Summary", "is_milestone": "Milestone",
    "plan_start": "Start", "plan_finish": "Finish",
    "actual_start": "ActualStart", "actual_finish": "ActualFinish",
    "early_start": "EarlyStart", "early_finish": "EarlyFinish",
    "late_start": "LateStart", "late_finish": "LateFinish",
    "constraint_date": "ConstraintDate", "deadline": "Deadline",
    "stop_date": "Stop", "resume_date": "Resume",
    "volume_plan": "SP_VolPlan", "volume_fact": "SP_VolFact",
    "volume_cost": "SP_VolCost", "percent_complete": "PercentComplete",
    "duration": "Duration", "actual_duration": "ActualDuration",
    "remaining_duration": "RemainingDuration", "calendar_uid": "CalendarUID",
}
INT_FIELDS = {"source_order", "uid", "id", "parent_uid", "outline_level", "is_summary", "is_milestone"}
REAL_FIELDS = {"volume_plan", "volume_fact", "volume_cost", "percent_complete"}
RUS_LABELS = {
    "source_order":"Порядок XML", "uid":"UID", "id":"ID", "parent_uid":"UID родителя",
    "task_name":"Наименование", "task_code":"Код работы Spider_Code",
    "work_code_pir":"Код работы ПИР", "wbs":"WBS", "outline_number":"OutlineNumber",
    "outline_level":"Уровень", "is_summary":"Суммарная", "is_milestone":"Веха",
    "project_code":"Код проекта", "cbs_code":"Код CBS", "cbs_name":"CBS",
    "kfo_code":"Код КФО", "kfo_name":"КФО", "plan_start":"Начало (Start)",
    "plan_finish":"Окончание (Finish)", "actual_start":"Факт начало",
    "actual_finish":"Факт окончание", "early_start":"Раннее начало", "early_finish":"Раннее окончание",
    "late_start":"Позднее начало", "late_finish":"Позднее окончание", "constraint_date":"Дата ограничения",
    "deadline":"Дедлайн", "stop_date":"Остановка", "resume_date":"Возобновление",
    "volume_plan":"Плановый объём", "volume_fact":"Фактический объём",
    "volume_cost":"Стоимостной показатель SP_VolCost", "percent_complete":"% выполнения",
    "duration":"Длительность", "actual_duration":"Фактическая длительность",
    "remaining_duration":"Остаточная длительность", "calendar_uid":"UID календаря",
    "nested_xml_json":"Вложенные XML-поля (JSON)",
}


def tag_name(el):
    return el.tag.rsplit("}", 1)[-1]


def direct_text(el, key):
    for child in el:
        if tag_name(child) == key:
            return child.text  # None stays None, '' stays ''
    return None


def nested_to_obj(el):
    if len(el) == 0:
        return el.text
    result = defaultdict(list)
    for ch in el:
        result[tag_name(ch)].append(nested_to_obj(ch))
    return {key: values for key, values in result.items()}


def as_int(value):
    if value is None or value == "":
        return None
    return int(value)


def sql_value(key, value):
    if value is None or value == "":
        return None
    if key in INT_FIELDS:
        return int(value)
    if key in REAL_FIELDS:
        try:
            return float(value)
        except (ValueError, TypeError):
            return None
    return value


def parse_xml(path):
    # ElementTree учитывает пространство имён, вместо текстового поиска по XML.
    root = ET.parse(path).getroot()
    if tag_name(root) != "Project":
        raise ValueError("Ожидается Microsoft Project XML с корневым элементом Project")
    project_data = {tag_name(ch): ch.text for ch in root if len(ch) == 0}
    attrs = next((ch for ch in root if tag_name(ch) == "ExtendedAttributes"), None)
    fieldid_to_alias = {}
    if attrs is not None:
        for a in attrs:
            if tag_name(a) == "ExtendedAttribute":
                fid, alias = direct_text(a, "FieldID"), direct_text(a, "Alias")
                if fid:
                    fieldid_to_alias[fid] = alias or direct_text(a, "FieldName") or f"FieldID_{fid}"
    alias_to_id = {alias: fid for fid, alias in fieldid_to_alias.items()}
    tasks_tag = next((ch for ch in root if tag_name(ch) == "Tasks"), None)
    if tasks_tag is None:
        raise ValueError("Отсутствует обязательный блок <Tasks>")
    tasks = [t for t in tasks_tag if tag_name(t) == "Task"]
    return project_data, fieldid_to_alias, alias_to_id, tasks


def build_records(tasks, fieldid_to_alias, alias_to_id):
    rows = []
    errors, warnings = [], []
    seen_uid = set()
    stack = []  # (уровень, uid, wbs)
    for order, task in enumerate(tasks):
        scalars = {}
        extras = []
        raw_attrs = {}
        for child in task:
            name = tag_name(child)
            if name == "ExtendedAttribute":
                fid = direct_text(child, "FieldID")
                if fid:
                    if fid in raw_attrs:
                        warnings.append(f"UID={direct_text(task,'UID')}: повтор FieldID {fid}")
                    raw_attrs[fid] = direct_text(child, "Value")
            elif len(child) == 0:
                scalars[name] = child.text
            else:
                extras.append({name: nested_to_obj(child)})

        uid = as_int(scalars.get("UID"))
        level = as_int(scalars.get("OutlineLevel"))
        if uid is None or level is None:
            errors.append(f"Task №{order}: отсутствует UID или OutlineLevel")
            continue
        if uid in seen_uid:
            errors.append(f"Task №{order}: дублирующийся UID={uid}")
        seen_uid.add(uid)
        while stack and stack[-1][0] >= level:
            stack.pop()
        parent_uid = stack[-1][1] if stack else None
        if level > 0 and (not stack or stack[-1][0] != level - 1):
            errors.append(f"UID={uid}: разрыв в OutlineLevel; уровень {level}")
        wbs = scalars.get("WBS")
        outline = scalars.get("OutlineNumber")
        if wbs != outline:
            warnings.append(f"UID={uid}: WBS={wbs!r} отличается от OutlineNumber={outline!r}")
        if wbs:
            expected_level = 0 if wbs == "0" else len(wbs.split("."))
            if expected_level != level:
                warnings.append(f"UID={uid}: глубина WBS {expected_level} != OutlineLevel {level}")
            if stack and stack[-1][0] > 0 and not wbs.startswith((stack[-1][2] or "") + "."):
                warnings.append(f"UID={uid}: WBS {wbs} не вложен в WBS родителя {stack[-1][2]}")
        stack.append((level, uid, wbs))

        row = {k: None for k in CORE_FIELDS}
        row["source_order"] = order
        row["parent_uid"] = parent_uid
        for dest, tag in CORE_FROM_XML.items():
            raw = scalars.get(tag)
            row[dest] = as_int(raw) if dest in INT_FIELDS else raw
        for alias, core in NAME_TO_CORE.items():
            fid = alias_to_id.get(alias)
            row[core] = raw_attrs.get(fid) if fid else None
        row["nested_xml_json"] = json.dumps(extras, ensure_ascii=False, separators=(",", ":")) if extras else None
        for name, value in scalars.items():
            row["xml__" + name] = value
        for fid, value in raw_attrs.items():
            row["ext__" + fid] = value
        rows.append(row)
    missing_aliases = sorted(set(NAME_TO_CORE).difference(alias_to_id))
    if missing_aliases:
        warnings.append("В схеме отсутствуют пользовательские поля: " + ", ".join(missing_aliases))
    return rows, errors, warnings


def sorted_columns(rows, fieldid_to_alias):
    dynamic = {name for row in rows for name in row if name not in CORE_FIELDS}
    # В начале — бизнес-поля, затем все исходные простые теги и все расширения.
    return CORE_FIELDS + sorted([n for n in dynamic if n.startswith("xml__")]) + sorted(
        [n for n in dynamic if n.startswith("ext__")], key=lambda x: int(x.split("__")[1])
    )


def write_csv(path, rows, columns):
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns, delimiter=";", extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def tree_from_rows(rows):
    nodes = {}
    roots = []
    for row in rows:
        node = {"work": row.copy(), "children": []}
        nodes[int(row["uid"])] = node
        p = row["parent_uid"]
        if p is not None and int(p) in nodes:
            nodes[int(p)]["children"].append(node)
        else:
            roots.append(node)
    return roots


def write_tree_txt(path, rows):
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            depth = int(row["outline_level"])
            prefix = "│   " * max(depth - 1, 0) + ("├── " if depth > 0 else "")
            f.write(f"{prefix}[{row.get('wbs') or '—'}] {row.get('task_name') or '—'} "
                    f"(UID={row['uid']}, Spider_Code={row.get('task_code') or '—'})\n")


def write_sqlite(path, rows, columns, project_meta, aliases, report):
    if path.exists():
        path.unlink()  # Детеминированная полная пересборка, без наслоения старой версии
    with sqlite3.connect(str(path)) as conn:
        definitions = []
        for col in columns:
            tp = "INTEGER" if col in INT_FIELDS else ("REAL" if col in REAL_FIELDS else "TEXT")
            definitions.append('"' + col.replace('"', '""') + '" ' + tp)
        conn.execute("CREATE TABLE tasks (" + ",".join(definitions) + ")")
        insert_cols = ",".join('"' + c + '"' for c in columns)
        placeholders = ",".join("?" for _ in columns)
        conn.executemany(f"INSERT INTO tasks ({insert_cols}) VALUES ({placeholders})",
                         ([sql_value(c, row.get(c)) for c in columns] for row in rows))
        conn.execute("CREATE UNIQUE INDEX idx_tasks_uid ON tasks(uid)")
        conn.execute("CREATE INDEX idx_tasks_parent ON tasks(parent_uid)")
        conn.execute("CREATE INDEX idx_tasks_wbs ON tasks(wbs)")
        conn.execute("CREATE INDEX idx_tasks_project_kfo ON tasks(project_code,kfo_code)")
        conn.execute("CREATE INDEX idx_tasks_order ON tasks(source_order)")
        conn.execute("CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT)")
        conn.executemany("INSERT INTO project_meta VALUES (?,?)", list(project_meta.items()))
        conn.execute("CREATE TABLE custom_field_dictionary (field_id TEXT PRIMARY KEY, alias TEXT)")
        conn.executemany("INSERT INTO custom_field_dictionary VALUES (?,?)", list(aliases.items()))
        conn.execute("CREATE TABLE parse_report (key TEXT PRIMARY KEY, value TEXT)")
        conn.executemany("INSERT INTO parse_report VALUES (?,?)",
                         [(k, json.dumps(v, ensure_ascii=False)) for k, v in report.items()])


def excel_safe(value):
    """Не превращать коды в числа, не распознавать текст как формулы."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    text = str(value)
    return text if not text.startswith(("=", "+", "-", "@")) else "'" + text


def excel_output(path, rows, aliases, report):
    try:
        from artifact_tool import Workbook, SpreadsheetFile
    except ImportError:
        return False, "artifact_tool не установлен: Excel не сформирован (CSV, SQLite и JSON сохранены)"
    wb = Workbook.create()
    cols = [c for c in CORE_FIELDS if c != "nested_xml_json"]
    widths = {"task_name": 42, "wbs": 20, "task_code": 24, "project_code": 17,
              "cbs_code": 17, "kfo_code": 19, "cbs_name": 30, "kfo_name": 30}
    for sheet_name, treeview in (("Таблица", False), ("Дерево", True)):
        sh = wb.worksheets.add(sheet_name)
        fields = (["Дерево / наименование"] if treeview else []) + cols
        values = [fields]
        for row in rows:
            cells = []
            if treeview:
                depth = int(row["outline_level"])
                cells.append("    " * depth + ("▸ " if str(row.get("is_summary")) == "1" else "• ") + (row.get("task_name") or ""))
            for col in cols:
                raw = row.get(col)
                if col in INT_FIELDS and raw not in (None, ""):
                    raw = int(raw)
                elif col in REAL_FIELDS and raw not in (None, ""):
                    try: raw = float(raw)
                    except ValueError: pass
                cells.append(excel_safe(raw))
            values.append(cells)
        # Не добавляем десятки тысяч файловых столбцов в Excel: полное сырьё есть в CSV / DB.
        sh.get_range_by_indexes(0, 0, len(values), len(fields)).values = values
        sh.get_range_by_indexes(0, 0, 1, len(fields)).format = {
            "fill": "#17365D", "font": {"bold": True, "color": "#FFFFFF"},
            "row_height": 29, "vertical_alignment": "center",
        }
        sh.freeze_panes.freeze_rows(1)
        sh.get_range_by_indexes(0, 0, len(values), 1).format.column_width = 44 if treeview else 12
        for i, col in enumerate(fields):
            width = 52 if (treeview and i == 0) else widths.get(col, 19)
            if col in ("source_order", "uid", "id", "parent_uid", "outline_level", "is_summary", "is_milestone"):
                width = 14
            sh.get_range_by_indexes(0, i, len(values), 1).format.column_width = width
        if treeview:
            sh.get_range_by_indexes(0, 0, len(values), 1).format.column_width = 65
        if len(values) > 1:
            sh.tables.add(f"A1:{xl_col(len(fields))}{len(values)}", True,
                          "TreeTasks" if treeview else "FlatTasks")
    dic = wb.worksheets.add("Словарь полей")
    pairs = [["FieldID", "Alias", "Колонка в CSV / SQLite"]] + [
        [fid, alias, "ext__" + fid] for fid, alias in sorted(aliases.items(), key=lambda p:int(p[0]))
    ]
    dic.get_range_by_indexes(0, 0, len(pairs), 3).values = pairs
    dic.get_range("A1:C1").format = {"fill":"#17365D", "font":{"bold":True,"color":"#FFFFFF"}}
    dic.get_range("A:A").format.column_width = 24
    dic.get_range("B:B").format.column_width = 39
    dic.get_range("C:C").format.column_width = 28
    ctl = wb.worksheets.add("Контроль")
    ctl_vals = [["Показатель", "Значение"]] + [[k, json.dumps(v, ensure_ascii=False)] for k,v in report.items() if k not in ("warnings", "errors")]
    ctl.get_range_by_indexes(0,0,len(ctl_vals),2).values = ctl_vals
    ctl.get_range("A1:B1").format = {"fill":"#17365D", "font":{"bold":True,"color":"#FFFFFF"}}
    ctl.get_range("A:A").format.column_width = 40
    ctl.get_range("B:B").format.column_width = 58
    SpreadsheetFile.export_xlsx(wb).save(str(path))
    return True, None


def xl_col(n):
    s = ""
    while n:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return s


def main():
    p = argparse.ArgumentParser(description="Microsoft Project XML → flat CSV/SQLite + tree JSON/TXT + XLSX")
    p.add_argument("xml", type=Path, help="исходный XML")
    p.add_argument("--out", type=Path, default=None, help="каталог результатов (по умолчанию <имя XML>_parsed)")
    p.add_argument("--no-xlsx", action="store_true", help="пропустить Excel, даже если есть artifact_tool")
    args = p.parse_args()
    if not args.xml.is_file():
        p.error(f"Нет файла: {args.xml}")
    dest = args.out or args.xml.with_name(args.xml.stem + "_parsed")
    dest.mkdir(parents=True, exist_ok=True)
    project, fieldids, alias_to_id, tasks = parse_xml(args.xml)
    rows, errors, warnings = build_records(tasks, fieldids, alias_to_id)
    cols = sorted_columns(rows, fieldids)
    counted = Counter(str(r.get("is_summary")) for r in rows)
    uid_issues = [row for row in rows if row.get("uid") is None]
    report = {
        "parser_version": SCHEMA_VERSION,
        "source_filename": args.xml.name,
        "sha256_xml": hashlib.sha256(args.xml.read_bytes()).hexdigest(),
        "project_name": project.get("Name"), "project_revision": project.get("Revision"),
        "project_status_date": project.get("StatusDate"),
        "task_count_xml": len(tasks), "task_count_exported": len(rows),
        "summary_tasks": counted.get("1", 0), "non_summary_tasks": counted.get("0", 0),
        "max_outline_level": max((int(r["outline_level"]) for r in rows), default=0),
        "with_cbs_code": sum(bool(r.get("cbs_code")) for r in rows),
        "with_kfo_code": sum(bool(r.get("kfo_code")) for r in rows),
        "with_volume_plan": sum(r.get("volume_plan") not in (None, "") for r in rows),
        "with_volume_fact": sum(r.get("volume_fact") not in (None, "") for r in rows),
        "with_actual_start": sum(r.get("actual_start") not in (None, "") for r in rows),
        "with_actual_finish": sum(r.get("actual_finish") not in (None, "") for r in rows),
        "missing_aliases": sorted(set(NAME_TO_CORE).difference(alias_to_id)),
        "errors": errors, "warnings": warnings,
    }
    if errors or uid_issues:
        (dest / "validation_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        raise RuntimeError("Обнаружены критические ошибки в UID/структуре, экспорт остановлен: " + "; ".join(errors[:3]))
    write_csv(dest / "works_flat.csv", rows, cols)
    write_sqlite(dest / "works.sqlite", rows, cols, project, fieldids, report)
    tree = tree_from_rows(rows)
    (dest / "works_tree.json").write_text(json.dumps(tree, indent=2, ensure_ascii=False), encoding="utf-8")
    write_tree_txt(dest / "works_tree.txt", rows)
    (dest / "project_metadata.json").write_text(json.dumps({"project":project,"custom_fields":fieldids}, indent=2, ensure_ascii=False), encoding="utf-8")
    (dest / "validation_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    (dest / "column_dictionary.json").write_text(json.dumps({
        "core_fields": RUS_LABELS, "source_xml_fields": {"xml__"+k:k for k in sorted({f[5:] for f in cols if f.startswith("xml__")})},
        "extended_fields": {"ext__"+fid: {"FieldID": fid, "Alias": alias} for fid, alias in fieldids.items()},
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    if args.no_xlsx:
        (dest / "works_table_and_tree.xlsx").unlink(missing_ok=True)
    else:
        try:
            okay, message = excel_output(dest / "works_table_and_tree.xlsx", rows, fieldids, report)
            if message: print("XLSX:", message)
        except Exception as exc:
            warnings.append("Не удалось создать дополнительный XLSX: " + str(exc))
            report["warnings"] = warnings
            (dest / "validation_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
            print("XLSX: не создан, остальные форматы готовы:", exc, file=sys.stderr)
    print(json.dumps({"output_dir": str(dest), "tasks":len(rows), "warnings":len(warnings),
                      "file_names":sorted(p.name for p in dest.iterdir())}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

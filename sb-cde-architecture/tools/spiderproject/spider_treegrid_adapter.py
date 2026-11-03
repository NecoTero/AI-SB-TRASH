#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SpiderProject TreeGrid UPD adapter v2.0

Reads works.sqlite from the existing parse_msproject_xml.py (v1.0) and produces:
  treegrid_rows.json   - flat TreeGrid-ready rows; full source Task attributes are preserved
  treegrid_tree.json   - nested tree with matching full records
  treegrid_manifest.json
  treegrid_validation.json

Only Python standard library is required. No inferred or inherited Task properties.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import sqlite3
import sys

VERSION = "2.0.0"
FIELDS = (
    "source_order", "uid", "id", "parent_uid", "task_name", "task_code", "work_code_pir",
    "wbs", "outline_number", "outline_level", "is_summary", "is_milestone",
    "project_code", "cbs_code", "cbs_name", "kfo_code", "kfo_name",
    "plan_start", "plan_finish", "actual_start", "actual_finish",
    "early_start", "early_finish", "late_start", "late_finish",
    "constraint_date", "deadline", "stop_date", "resume_date",
    "volume_plan", "volume_fact", "volume_cost", "percent_complete",
    "duration", "actual_duration", "remaining_duration", "calendar_uid",
)
DATE_FIELDS = (
    "plan_start", "plan_finish", "actual_start", "actual_finish",
    "early_start", "early_finish", "late_start", "late_finish",
    "constraint_date", "deadline", "stop_date", "resume_date",
)
DECIMAL_FROM_SOURCE = {
    "volume_plan": "xml__SP_VolPlan",
    "volume_fact": "xml__SP_VolFact",
    "volume_cost": "xml__SP_VolCost",
    "percent_complete": "xml__PercentComplete",
}


def load_json_value(value):
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return value


def read_database(db: Path):
    if not db.is_file():
        raise FileNotFoundError(f"Нет базы: {db}")
    with sqlite3.connect(str(db)) as conn:
        conn.row_factory = sqlite3.Row
        table_names = {item[0] for item in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'tasks' not in table_names:
            raise ValueError("Нужна SQLite-база парсера v1 с таблицей tasks")
        columns = {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
        missing = set(FIELDS) - columns
        if missing:
            raise ValueError(f"Отсутствуют поля предыдущего парсера: {sorted(missing)}")
        rows = [dict(x) for x in conn.execute("SELECT * FROM tasks ORDER BY source_order")]
        meta = dict(conn.execute("SELECT key,value FROM project_meta")) if "project_meta" in table_names else {}
        report = {k: load_json_value(v) for k, v in conn.execute("SELECT key,value FROM parse_report")} if "parse_report" in table_names else {}
    return rows, meta, report


def convert(rows, meta, source_report, platform_project_id):
    errors = []
    warnings = []
    sha = source_report.get("sha256_xml")
    if not isinstance(sha, str) or len(sha) != 64:
        raise ValueError("В parse_report нет SHA-256 исходного XML: нельзя создать ID версии")
    snapshot_id = sha.lower()
    ordered = sorted(rows, key=lambda r: r["source_order"] if r["source_order"] is not None else -1)
    uid_freq = Counter(x["uid"] for x in ordered)
    order_freq = Counter(x["source_order"] for x in ordered)
    duplicate_uids = [k for k, v in uid_freq.items() if v > 1]
    duplicate_orders = [k for k, v in order_freq.items() if v > 1]
    if duplicate_uids: errors.append(f"Повторяющиеся UID: {duplicate_uids[:10]}")
    if duplicate_orders: errors.append(f"Повторяющиеся source_order: {duplicate_orders[:10]}")
    if any(r["uid"] is None or r["outline_level"] is None or r["source_order"] is None for r in ordered):
        errors.append("Есть Task без UID, OutlineLevel или source_order")
    if errors:
        return [], [], {}, {"status":"failed", "errors":errors,"warnings":warnings}

    uids = {x["uid"] for x in ordered}
    parent_for = {x["uid"]: x["parent_uid"] for x in ordered}
    row_by_uid = {x["uid"]: x for x in ordered}
    if sorted(order_freq.keys()) != list(range(len(ordered))):
        errors.append("source_order не образует непрерывный ряд 0 ... N-1")
    roots = [x for x in ordered if x["parent_uid"] is None]
    if not roots: errors.append("Нет корневых задач")
    if len(roots) != 1: warnings.append(f"Корней не один: {len(roots)}. Сохранён лес без искусственного корня")
    children_count = Counter()
    for r in ordered:
        p = r["parent_uid"]
        if p is None:
            if r["outline_level"] != 0:
                errors.append(f"UID={r['uid']}: корень не на уровне 0")
            continue
        if p not in uids:
            errors.append(f"UID={r['uid']}: отсутствует родитель {p}")
            continue
        children_count[p] += 1
        parent = row_by_uid[p]
        if parent["source_order"] >= r["source_order"]:
            errors.append(f"UID={r['uid']}: родитель расположен не раньше ребёнка")
        if parent["outline_level"] + 1 != r["outline_level"]:
            errors.append(f"UID={r['uid']}: OutlineLevel ребёнка не на единицу больше родителя")
    for r in ordered:
        if children_count.get(r["uid"], 0) and r["is_summary"] != 1:
            warnings.append(f"UID={r['uid']}: есть дети, но Summary != 1. Раскрытие определять по детям")

    normalized = []
    row_ids = {}
    for r in ordered:
        uid = r["uid"]
        row_ids[uid] = f"{snapshot_id}:{uid}"
    for r in ordered:
        uid, p = r["uid"], r["parent_uid"]
        obj = {field: r[field] for field in FIELDS}
        # Never use a float representation as the authoritative volume: use raw XML decimal strings.
        for col, raw_col in DECIMAL_FROM_SOURCE.items():
            obj[col] = r.get(raw_col)
        obj.update({
            "row_id": row_ids[uid],
            "parent_row_id": row_ids[p] if p is not None and p in row_ids else None,
            "platform_project_id": platform_project_id,
            "snapshot_id": snapshot_id,
            "sort_index": r["source_order"],
            "node_type": "summary" if r["is_summary"] == 1 else ("milestone" if r["is_milestone"] == 1 else "task"),
            "has_children": children_count[uid] > 0,
            "children_count": children_count[uid],
        })
        # Every raw simple XML tag, every custom FieldID, plus nested XML structures.
        obj["source_attributes"] = {k:r[k] for k in r if k.startswith("xml__") or k.startswith("ext__")}
        obj["nested_xml_json"] = r.get("nested_xml_json")
        normalized.append(obj)

    # Nested tree contains the same per-task values as flat rows (except source is not duplicated in meta).
    nodes = {x["uid"]: {"work":x, "children":[]} for x in normalized}
    tree = []
    for x in normalized:
        p = x["parent_uid"]
        if p is None:
            tree.append(nodes[x["uid"]])
        elif p in nodes:
            nodes[p]["children"].append(nodes[x["uid"]])

    # Validate visited count without recursion to avoid pathological depth issues.
    visited, path = set(), list(tree)
    while path:
        node = path.pop()
        uid = node["work"]["uid"]
        if uid in visited:
            errors.append(f"UID={uid} встречается в дереве повторно (цикл/дубль)")
            continue
        visited.add(uid)
        path.extend(node["children"])
    if len(visited) != len(normalized):
        errors.append(f"Число узлов в дереве {len(visited)} не совпадает с таблицей {len(normalized)}")

    code_counts = Counter(x["task_code"] for x in normalized if x["task_code"] is not None)
    repeated_codes = {k:v for k,v in code_counts.items() if v > 1}
    if repeated_codes:
        warnings.append(f"Найдены повторяющиеся Spider_Code: {len(repeated_codes)} различных повторённых значений. Не применять task_code как PK")
    manifest = {
        "contract_version": VERSION,
        "platform_project_id": platform_project_id,
        "snapshot_id": snapshot_id,
        "source_filename": source_report.get("source_filename"),
        "source_sha256": snapshot_id,
        "source_revision": meta.get("Revision"),
        "source_project_name": meta.get("Name"),
        "source_status_date": meta.get("StatusDate"),
        "row_count": len(normalized),
        "root_uid_values": [x["uid"] for x in roots],
        "max_outline_level": max(x["outline_level"] for x in normalized) if normalized else None,
        "all_values_from": "works.sqlite created by parse_msproject_xml.py; raw XML captured in source_attributes",
        "decimal_fields_as_original_strings": list(DECIMAL_FROM_SOURCE),
        "date_fields_as_original_strings": list(DATE_FIELDS),
        "identity_policy": "(platform_project_id, snapshot_id, uid); never key by WBS, task name or Spider_Code",
    }
    report = {
        "status": "passed" if not errors else "failed",
        "source_tasks": len(rows),
        "flat_rows": len(normalized),
        "nested_tree_nodes": len(visited),
        "root_count": len(roots),
        "child_links": sum(children_count.values()),
        "max_outline_level": manifest["max_outline_level"],
        "unique_task_codes": len(code_counts),
        "duplicate_task_codes_distinct_values": len(repeated_codes),
        "errors": errors,
        "warnings": warnings,
    }
    return normalized, tree, manifest, report


def write_json(path, content):
    path.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    p = argparse.ArgumentParser(description="UPD: works.sqlite -> SpiderProject TreeGrid API contract")
    p.add_argument("--db", required=True, type=Path, help="SQLite from parser v1")
    p.add_argument("--platform-project-id", required=True, help="ID текущего проекта платформы, берётся из контекста, не из XML")
    p.add_argument("--out", required=True, type=Path)
    args = p.parse_args()
    if not args.platform_project_id.strip():
        p.error("--platform-project-id не может быть пустым")
    args.out.mkdir(parents=True, exist_ok=True)
    rows, meta, original_report = read_database(args.db)
    flat, tree, manifest, report = convert(rows, meta, original_report, args.platform_project_id)
    write_json(args.out / "treegrid_validation.json", report)
    if report["errors"]:
        print(json.dumps(report, ensure_ascii=False, indent=2), file=sys.stderr)
        sys.exit(2)
    write_json(args.out / "treegrid_rows.json", {"manifest":manifest, "rows":flat})
    write_json(args.out / "treegrid_tree.json", {"manifest":manifest, "tree":tree})
    write_json(args.out / "treegrid_manifest.json", manifest)
    print(json.dumps({"status":report["status"], "rows":len(flat), "roots":len(tree), "output":str(args.out)}, ensure_ascii=False))

if __name__ == "__main__":
    main()

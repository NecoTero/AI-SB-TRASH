#!/usr/bin/env python3
"""Produce a user-facing leaf-work table and hierarchy metadata from works.sqlite.

Does not modify source database. By default, excludes summary tasks and milestones.
Use --include-milestones if your product policy treats milestone rows as work rows.
"""
import argparse
import csv
import json
import sqlite3
from pathlib import Path

DISPLAY_FIELDS = [
    'uid', 'parent_uid', 'source_order', 'wbs', 'outline_level', 'task_name',
    'task_code', 'project_code', 'cbs_code', 'kfo_code', 'plan_start',
    'plan_finish', 'actual_start', 'actual_finish', 'volume_plan',
    'volume_fact', 'percent_complete', 'hierarchy_path'
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('db', type=Path, help='Existing works.sqlite')
    parser.add_argument('--out', type=Path, default=Path('result_ui'))
    parser.add_argument('--include-milestones', action='store_true')
    args = parser.parse_args()
    if not args.db.is_file():
        parser.error(f'Database does not exist: {args.db}')
    args.out.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(f'file:{args.db.resolve()}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    all_rows = [dict(x) for x in db.execute('SELECT * FROM tasks ORDER BY source_order')]
    by_uid = {x['uid']: x for x in all_rows}
    if len(by_uid) != len(all_rows):
        raise ValueError('UID is not unique inside the snapshot')

    def hierarchy(row):
        ancestors = []
        seen = {row['uid']}
        cursor = row
        while cursor['parent_uid'] is not None:
            parent_uid = cursor['parent_uid']
            if parent_uid in seen:
                raise ValueError(f'Cycle in parent chain of UID {row["uid"]}')
            if parent_uid not in by_uid:
                raise ValueError(f'Missing parent UID {parent_uid} for {row["uid"]}')
            seen.add(parent_uid)
            cursor = by_uid[parent_uid]
            ancestors.append({
                'uid': cursor['uid'],
                'wbs': cursor['wbs'],
                'task_name': cursor['task_name'],
                'outline_level': cursor['outline_level'],
            })
        return list(reversed(ancestors))

    results = []
    for row in all_rows:
        if row['is_summary'] != 0:
            continue
        if not args.include_milestones and row['is_milestone'] == 1:
            continue
        a = hierarchy(row)
        display = {field: row.get(field) for field in DISPLAY_FIELDS if field != 'hierarchy_path'}
        display['hierarchy_path'] = ' / '.join(
            [x['task_name'] or '' for x in a] + [row.get('task_name') or '']
        )
        display['ancestors'] = a
        display['is_milestone'] = row['is_milestone']
        results.append(display)

    csv_path = args.out / 'works_ui_rows.csv'
    with csv_path.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=DISPLAY_FIELDS, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(results)
    json_path = args.out / 'works_ui_rows.json'
    json_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    n_leaf = sum(r['is_summary'] == 0 for r in all_rows)
    n_summaries = sum(r['is_summary'] == 1 for r in all_rows)
    n_milestones = sum(r['is_milestone'] == 1 for r in all_rows)
    print(f'Source: {len(all_rows)} tasks; summaries: {n_summaries}; non-summary: {n_leaf}; milestones: {n_milestones}')
    print(f'User work rows: {len(results)}; saved CSV: {csv_path}; JSON: {json_path}')
    db.close()


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests that TreeGrid API snapshots match source records in works.sqlite exactly."""
import argparse
import json
from pathlib import Path
import sqlite3


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--db', required=True, type=Path)
    p.add_argument('--folder', required=True, type=Path)
    args = p.parse_args()
    with sqlite3.connect(str(args.db)) as db:
        db.row_factory = sqlite3.Row
        original = [dict(x) for x in db.execute('SELECT * FROM tasks ORDER BY source_order')]
    payload = json.loads((args.folder/'treegrid_rows.json').read_text(encoding='utf-8'))
    tree_payload = json.loads((args.folder/'treegrid_tree.json').read_text(encoding='utf-8'))
    validation = json.loads((args.folder/'treegrid_validation.json').read_text(encoding='utf-8'))
    rows = payload['rows']
    assert validation['status']=='passed', validation
    assert len(rows)==len(original), (len(rows),len(original))
    by_uid = {r['uid']:r for r in rows}
    assert len(by_uid)==len(rows), 'Duplicate uid'
    assert len({r['row_id'] for r in rows})==len(rows), 'Duplicate row_id'
    assert len({r['sort_index'] for r in rows})==len(rows), 'Duplicate position'
    checks=['uid','parent_uid','id','source_order','wbs','outline_number','outline_level',
            'task_name','task_code','project_code','cbs_code','kfo_code','is_summary','is_milestone',
            'plan_start','plan_finish','actual_start','actual_finish','early_start','early_finish',
            'late_start','late_finish','constraint_date','deadline','stop_date','resume_date',
            'duration','actual_duration','remaining_duration']
    for src, row in zip(original, rows):
        for field in checks:
            assert src[field] == row[field], (src['uid'], field, src[field],row[field])
        for key, source_col in [('volume_plan','xml__SP_VolPlan'),('volume_fact','xml__SP_VolFact'),
                                ('volume_cost','xml__SP_VolCost'),('percent_complete','xml__PercentComplete')]:
            assert row[key]==src[source_col], (src['uid'],key)
        assert row['source_order']==row['sort_index']
        assert row['source_attributes']=={k:v for k,v in src.items() if k.startswith(('xml__','ext__'))}
        if src['parent_uid'] is None:
            assert row['parent_row_id'] is None
        else:
            assert row['parent_row_id']==by_uid[src['parent_uid']]['row_id']
    stack=list(tree_payload['tree']); gathered=[]
    while stack:
        node=stack.pop()
        gathered.append(node['work']['uid'])
        stack.extend(node['children'])
    assert len(gathered)==len(rows) and set(gathered)==set(by_uid)
    assert payload['manifest']==tree_payload['manifest']
    print(json.dumps({'ok':True,'tasks':len(rows),'roots':len(tree_payload['tree']),
                      'summaries':sum(x['is_summary']==1 for x in rows),
                      'max_level':max(x['outline_level'] for x in rows)},ensure_ascii=False))
if __name__=='__main__':
    main()

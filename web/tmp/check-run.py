"""检查第三章 runId 的工作流事件推进情况。"""
import urllib.request
import json

BASE = 'http://127.0.0.1:4766'
PROJECT_ID = '99328e42-f08b-49ac-b867-67690963b2e7'
RUN_ID = 'cb6c8636-802d-44bd-a690-7b9f644ca5bf'

with urllib.request.urlopen(f'{BASE}/v1/projects/{PROJECT_ID}/records') as resp:
    data = json.loads(resp.read().decode('utf-8'))
records = data['records']

# creativeRuns
runs = records.get('creativeRuns', [])
print(f'== creativeRuns: {len(runs)} ==')
# 找当前 run
current_run = next((r for r in runs if r.get('id') == RUN_ID), None)
if current_run:
    print(f'current run: status={current_run.get("status")} updatedAt={current_run.get("updatedAt")}')
    print(f'  keys: {sorted(current_run.keys())}')
else:
    print(f'current run {RUN_ID[:8]} NOT FOUND in records')

# 最新 3 个 runs
print('\nlatest 3 runs:')
for r in sorted(runs, key=lambda x: x.get('updatedAt', 0))[-3:]:
    print(f'  {r.get("id")[:8]}.. status={r.get("status")} updatedAt={r.get("updatedAt")} workItem={r.get("currentWorkItemId","-")[:8] if r.get("currentWorkItemId") else "-"}')

# creativeRunEvents for current run
events = records.get('creativeRunEvents', [])
run_events = [e for e in events if e.get('runId') == RUN_ID]
print(f'\n== creativeRunEvents for current run: {len(run_events)} ==')
for ev in sorted(run_events, key=lambda x: x.get('createdAt', 0))[-15:]:
    print(f'  {ev.get("createdAt")} type={ev.get("type","-")} phase={ev.get("phase","-")} workItem={ev.get("workItemId","-")[:8] if ev.get("workItemId") else "-"}')
    msg = ev.get('message') or ev.get('summary') or ''
    if msg:
        print(f'    msg: {msg[:150]}')

# creativeWorkItems
wis = records.get('creativeWorkItems', [])
current_wi = next((w for w in wis if w.get('id') == '8a83f34c-6c32-4039-af32-4427d21d1599'), None)
print(f'\n== current workItem 8a83f34c ==')
if current_wi:
    print(f'  status={current_wi.get("status")} kind={current_wi.get("kind")} phase={current_wi.get("phase")}')
    print(f'  updatedAt={current_wi.get("updatedAt")}')
    print(f'  keys: {sorted(current_wi.keys())}')
    # 输出非嵌套字段
    for k, v in current_wi.items():
        if k in ('id', 'runId', 'projectId', 'kind', 'status', 'phase', 'createdAt', 'updatedAt', 'workItemId'):
            continue
        sv = str(v)
        print(f'  {k}: {sv[:120]}')
else:
    print('  NOT FOUND')

# 最新几个 workItems
print('\nlatest 5 workItems:')
for w in sorted(wis, key=lambda x: x.get('updatedAt', 0))[-5:]:
    print(f'  {w.get("id")[:8]}.. kind={w.get("kind")} status={w.get("status")} phase={w.get("phase","-")} updatedAt={w.get("updatedAt")}')

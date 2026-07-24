"""查看第三章失败的完整错误和 operation 状态。"""
import urllib.request
import json

BASE = 'http://127.0.0.1:4766'
PROJECT_ID = '99328e42-f08b-49ac-b867-67690963b2e7'
OP_ID = '6b8bebdd-f0da-4e3c-8081-c08ae4c2474a'
RUN_ID = 'cb6c8636-802d-44bd-a690-7b9f644ca5bf'
WI_ID = '8a83f34c-6c32-4039-af32-4427d21d1599'

# 1. operation 完整状态
with urllib.request.urlopen(f'{BASE}/v1/operations/{OP_ID}?projectId={PROJECT_ID}') as resp:
    data = json.loads(resp.read().decode('utf-8'))
op = data.get('operation', {})
print('== operation ==')
print(f'status: {op.get("status")}')
print(f'attempt: {op.get("attempt")}')
print(f'updatedAt: {op.get("updatedAt")}')
err = op.get('error')
if err:
    print(f'error (full):\n{err}')

# 2. records 里的 workItem 完整 error
with urllib.request.urlopen(f'{BASE}/v1/projects/{PROJECT_ID}/records') as resp:
    recs = json.loads(resp.read().decode('utf-8'))['records']

wis = recs.get('creativeWorkItems', [])
wi = next((w for w in wis if w.get('id') == WI_ID), None)
if wi:
    print(f'\n== workItem {WI_ID[:8]} ==')
    print(f'status: {wi.get("status")}')
    print(f'error (full):\n{wi.get("error")}')

# 3. creativeRun error
runs = recs.get('creativeRuns', [])
run = next((r for r in runs if r.get('id') == RUN_ID), None)
if run:
    print(f'\n== creativeRun {RUN_ID[:8]} ==')
    print(f'status: {run.get("status")}')
    print(f'error (full):\n{run.get("error")}')

# 4. 检查 creativeRunEvents（所有，最新 10）
crevs = recs.get('creativeRunEvents', [])
print(f'\n== creativeRunEvents total: {len(crevs)} ==')
# 找当前 run 的事件（可能 runId 字段名不同）
run_events = [e for e in crevs if e.get('runId') == RUN_ID or e.get('creativeRunId') == RUN_ID]
print(f'current run events: {len(run_events)}')
# 最新 10 个事件
for ev in sorted(crevs, key=lambda x: x.get('createdAt', 0))[-10:]:
    rid = ev.get('runId') or ev.get('creativeRunId') or '-'
    print(f'  {ev.get("createdAt")} run={rid[:8] if isinstance(rid,str) else "-"} type={ev.get("type","-")} msg={(ev.get("message") or ev.get("summary") or "")[:100]}')

"""轮询第三章写作操作状态。"""
import urllib.request
import json
import time

BASE = 'http://127.0.0.1:4766'
OP_ID = '6b8bebdd-f0da-4e3c-8081-c08ae4c2474a'
PROJECT_ID = '99328e42-f08b-49ac-b867-67690963b2e7'

with urllib.request.urlopen(f'{BASE}/v1/operations/{OP_ID}?projectId={PROJECT_ID}') as resp:
    data = json.loads(resp.read().decode('utf-8'))

op = data.get('operation', {})
print(f'status: {op.get("status")}')
print(f'attempt: {op.get("attempt")}')
print(f'updatedAt: {op.get("updatedAt")}')
print(f'runId: {op.get("runId")}')
print(f'currentWorkItemId: {op.get("currentWorkItemId")}')
print(f'currentChangeId: {op.get("currentChangeId")}')
err = op.get('error')
if err:
    print(f'error: {err[:500]}')

change = data.get('change')
if change:
    print(f'\nchange: {change.get("id")[:8]}.. status={change.get("status")}')
    print(f'  artifactRefs: {change.get("artifactRefs",[])}')

events = data.get('events', [])
print(f'\nevents: {len(events)} (last 8)')
for ev in events[-8:]:
    print(f'  seq={ev.get("sequence")} type={ev.get("type")} at={ev.get("createdAt")}')
    payload = ev.get('payload', {})
    if payload:
        print(f'    payload: {json.dumps(payload, ensure_ascii=False)[:200]}')

na = data.get('nextActions', [])
print(f'\nnextActions: {len(na)}')
for a in na[:3]:
    print(f'  type={a.get("type")} reason={a.get("reason","")[:120]}')

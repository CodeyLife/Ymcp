"""循环轮询第三章写作操作，状态变化或完成时输出。最多等 25 分钟。"""
import urllib.request
import json
import time
import sys

BASE = 'http://127.0.0.1:4766'
OP_ID = '6b8bebdd-f0da-4e3c-8081-c08ae4c2474a'
PROJECT_ID = '99328e42-f08b-49ac-b867-67690963b2e7'

INTERVAL = 45
MAX_WAIT = 25 * 60
start = time.time()
last_status = None
last_workitem = None
last_change = None
last_event_seq = 0

while time.time() - start < MAX_WAIT:
    try:
        with urllib.request.urlopen(f'{BASE}/v1/operations/{OP_ID}?projectId={PROJECT_ID}', timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f'[poll error] {e}', flush=True)
        time.sleep(INTERVAL)
        continue

    op = data.get('operation', {})
    status = op.get('status')
    workitem = op.get('currentWorkItemId')
    change_id = op.get('currentChangeId')
    attempt = op.get('attempt')
    err = op.get('error')

    events = data.get('events', [])
    new_events = [e for e in events if e.get('sequence', 0) > last_event_seq]
    if new_events:
        last_event_seq = new_events[-1].get('sequence', last_event_seq)

    # 状态变化或新事件时输出
    if status != last_status or workitem != last_workitem or change_id != last_change or new_events:
        elapsed = int(time.time() - start)
        print(f'[{elapsed}s] status={status} attempt={attempt} workitem={workitem[:8] if workitem else None} change={change_id[:8] if change_id else None}', flush=True)
        if err:
            print(f'  error: {err[:300]}', flush=True)
        for ev in new_events:
            print(f'  +event seq={ev.get("sequence")} type={ev.get("type")}', flush=True)
        last_status = status
        last_workitem = workitem
        last_change = change_id

    # 终态
    if status in ('awaiting_review', 'completed', 'failed', 'cancelled'):
        print(f'\n== terminal: {status} ==', flush=True)
        change = data.get('change')
        if change:
            print(f'change: {change.get("id")} status={change.get("status")}', flush=True)
            print(f'  artifactRefs: {change.get("artifactRefs",[])}', flush=True)
        na = data.get('nextActions', [])
        print(f'nextActions: {len(na)}', flush=True)
        for a in na[:5]:
            print(f'  type={a.get("type")} reason={a.get("reason","")[:150]}', flush=True)
        break

    time.sleep(INTERVAL)

else:
    print(f'\n== timeout after {MAX_WAIT}s, last status={last_status} ==', flush=True)

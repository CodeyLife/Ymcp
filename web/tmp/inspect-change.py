"""查看候选变更详情。"""
import urllib.request
import json

BASE = 'http://127.0.0.1:4766'
CHANGE_ID = 'a557cedc'  # 实际完整 id 需要先从 records/status 获取


def get(path):
    with urllib.request.urlopen(f'{BASE}{path}') as resp:
        return json.loads(resp.read().decode('utf-8'))


# 先拿到完整 change id 和 operation id
status = get('/v1/projects/99328e42-f08b-49ac-b867-67690963b2e7/status')
for ch in status.get('pendingChanges', []):
    cid = ch.get('id')
    oid = ch.get('operationId')
    print(f'change: {cid}')
    print(f'operation: {oid}')
    print(f'status: {ch.get("status")}')
    print(f'artifactRefs: {ch.get("artifactRefs",[])}')
    print(f'patches: {len(ch.get("patches",[]))}')
    # 拿变更详情
    details = get(f'/v1/changes/{cid}')
    print('\n== change details ==')
    print(f'verdict candidates: {len(details.get("candidates",[]))}')
    print(f'artifact kind: {(details.get("artifact") or {}).get("kind")}')
    items = ((details.get("artifact") or {}).get("value") or {}).get("items", [])
    print(f'artifact items: {len(items)}')
    for i, item in enumerate(items):
        pl = item.get('payload') or {}
        print(f'\n--- item {i} ---')
        print(f'  label: {item.get("label")}')
        print(f'  targetTable: {item.get("targetTable")}')
        print(f'  payload.name: {pl.get("name")}')
        print(f'  payload.kind: {pl.get("kind")}')
        print(f'  payload.faction: {pl.get("faction")}')
        print(f'  payload.romanceArchetype: {(pl.get("romanceArchetype") or "")[:60]}')
        print(f'  payload.biography[:100]: {(pl.get("biography") or "")[:100]}')

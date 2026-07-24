"""快速检查项目状态：章节、角色、操作。"""
import urllib.request
import json

PROJECT_ID = '99328e42-f08b-49ac-b867-67690963b2e7'
BASE = 'http://127.0.0.1:4766'


def get(path):
    with urllib.request.urlopen(f'{BASE}{path}') as resp:
        return json.loads(resp.read().decode('utf-8'))


# 章节与角色
records = get(f'/v1/projects/{PROJECT_ID}/records')['records']
print('== documents ==')
for doc in records.get('documents', []):
    print(f'  {doc.get("id")[:8]}.. title={doc.get("title")!r} status={doc.get("status")} words={len(doc.get("content","") or "")}')

print('\n== character entities ==')
for e in records.get('entities', []):
    if e.get('kind') == 'character':
        print(f'  {e.get("name")!r} faction={e.get("faction","-")} archetype={e.get("romanceArchetype","-")[:30]}')

print('\n== plot threads ==')
for pt in records.get('plotThreads', []):
    print(f'  {pt.get("id")[:8]}.. title={pt.get("title")!r} kind={pt.get("kind","-")}')

# 状态
status = get(f'/v1/projects/{PROJECT_ID}/status')
ops = status.get('operations', [])
print(f'\n== operations total={len(ops)} ==')
for op in ops[-8:]:
    print(f'  {op.get("id")[:8]}.. kind={op.get("kind")} status={op.get("status")} attempt={op.get("attempt")} updated={op.get("updatedAt")}')

print('\n== active ops ==')
for op in status.get('activeOperations', []):
    print(f'  {op.get("id")[:8]}.. kind={op.get("kind")} status={op.get("status")}')
    print(f'    input: {json.dumps(op.get("input",{}), ensure_ascii=False)[:200]}')

print('\n== pending changes ==')
for ch in status.get('pendingChanges', []):
    print(f'  change {ch.get("id")[:8]}.. op={ch.get("operationId")[:8]}.. status={ch.get("status")}')

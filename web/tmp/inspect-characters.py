"""检查现有角色实体的完整 payload 字段结构，作为创建新角色的模板。"""
import urllib.request
import json

PROJECT_ID = '99328e42-f08b-49ac-b867-67690963b2e7'
BASE = 'http://127.0.0.1:4766'


def get(path):
    with urllib.request.urlopen(f'{BASE}{path}') as resp:
        return json.loads(resp.read().decode('utf-8'))


records = get(f'/v1/projects/{PROJECT_ID}/records')['records']
print('== character payload structures ==')
for e in records.get('entities', []):
    if e.get('kind') == 'character':
        print(f'\n--- {e.get("name")} ---')
        print(f'  keys: {sorted(e.keys())}')
        print(f'  id: {e.get("id")}')
        print(f'  schemaVersion: {e.get("schemaVersion")}')
        print(f'  revision: {e.get("revision")}')
        print(f'  projectId: {e.get("projectId")}')
        print(f'  createdBy: {e.get("createdBy")}')
        print(f'  updatedBy: {e.get("updatedBy")}')
        print(f'  aliases: {e.get("aliases")}')
        print(f'  biography[:80]: {(e.get("biography") or "")[:80]}')
        print(f'  personality[:80]: {(e.get("personality") or "")[:80]}')
        print(f'  appearance[:80]: {(e.get("appearance") or "")[:80]}')
        print(f'  abilities[:80]: {(e.get("abilities") or "")[:80]}')
        print(f'  motivation[:80]: {(e.get("motivation") or "")[:80]}')
        print(f'  arc[:80]: {(e.get("arc") or "")[:80]}')
        print(f'  relations: {e.get("relations")}')
        print(f'  faction: {e.get("faction")}')
        print(f'  romanceArchetype: {e.get("romanceArchetype")}')
        # 所有非字符串字段
        for k, v in e.items():
            if k in ('id', 'name', 'kind', 'schemaVersion', 'revision', 'projectId', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'aliases', 'biography', 'personality', 'appearance', 'abilities', 'motivation', 'arc', 'relations', 'faction', 'romanceArchetype'):
                continue
            print(f'  {k}: {v}')

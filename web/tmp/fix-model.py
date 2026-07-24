"""强制将 project.settings.textModel 改回 gpt-5-5，遵守项目硬约束。"""
import urllib.request
import json

BASE = 'http://127.0.0.1:4766'
PROJECT_ID = '99328e42-f08b-49ac-b867-67690963b2e7'
ACTOR = {"type": "user", "id": "local-user"}


def call(method, path, payload=None):
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(
        f'{BASE}{path}', data=data, method=method,
        headers={'content-type': 'application/json; charset=utf-8'},
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode('utf-8'))


# 拿到当前 project 完整 record（从 records API，projects 集合）
records = call('GET', f'/v1/projects/{PROJECT_ID}/records')['records']
projects = records.get('projects', [])
if not projects:
    raise SystemExit('project record not found')
proj = projects[0]
print(f'before: textModel={proj.get("settings",{}).get("textModel")!r}')

# 修改 settings.textModel
settings = proj.get('settings', {}) or {}
settings['textModel'] = 'gpt-5-5'
proj['settings'] = settings
proj['updatedAt'] = proj.get('updatedAt', 0)  # 保持，mutation 会更新

# 通过 mutation API put（expectedRevision 用当前 revision）
result = call('POST', f'/v1/projects/{PROJECT_ID}/mutations', {
    'actor': ACTOR,
    'mutations': [{
        'type': 'put',
        'collection': 'projects',
        'id': proj['id'],
        'expectedRevision': proj.get('revision'),
        'value': proj,
    }],
})
changed = result.get('changed', [])
print(f'changed: {changed}')
# 验证
new_projects = result.get('records', {}).get('projects', [])
if new_projects:
    print(f'after: textModel={new_projects[0].get("settings",{}).get("textModel")!r}')

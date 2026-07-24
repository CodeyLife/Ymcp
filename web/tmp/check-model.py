"""通过 runtime API 检查项目 settings.textModel。"""
import urllib.request
import json

BASE = 'http://127.0.0.1:4766'
PROJECT_ID = '99328e42-f08b-49ac-b867-67690963b2e7'

with urllib.request.urlopen(f'{BASE}/v1/projects/{PROJECT_ID}') as resp:
    data = json.loads(resp.read().decode('utf-8'))

proj = data.get('project', {})
settings = proj.get('settings', {})
print(f'title: {proj.get("title")}')
print(f'status: {proj.get("status")}')
print(f'settings.textModel: {settings.get("textModel")!r}')
print(f'settings.targetWords: {settings.get("targetWords")}')

docs = data.get('documents', [])
print(f'\ndocuments: {len(docs)}')
for d in docs:
    print(f'  {d.get("id")[:8]}.. {d.get("title")!r} status={d.get("status")} order={d.get("order")} words={len(d.get("content","") or "")}')

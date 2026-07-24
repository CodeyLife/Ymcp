"""直接修改 SQLite 中 project.settings.textModel 为 claude-3-5-sonnet（临时）。"""
import sqlite3
import json

DB = r'C:\Users\admin\AppData\Local\Ymcp\novel-runtime.sqlite'
PROJECT_ID = '99328e42-f08b-49ac-b867-67690963b2e7'
NEW_MODEL = 'claude-3-5-sonnet'

db = sqlite3.connect(DB)
c = db.cursor()

c.execute(
    "SELECT payload FROM novel_records WHERE collection=? AND id=?",
    ('projects', PROJECT_ID),
)
row = c.fetchone()
if not row:
    raise SystemExit("project record not found")

project = json.loads(row[0])
old_model = project.get('settings', {}).get('textModel')
old_rev = project.get('revision', 0)
project['settings']['textModel'] = NEW_MODEL
project['revision'] = old_rev + 1
project['updatedBy'] = 'goal-loop-9-temp-claude'
project['updatedAt'] = int(__import__('time').time() * 1000)

c.execute(
    "UPDATE novel_records SET payload=?, updated_at=? WHERE collection=? AND id=?",
    (json.dumps(project, ensure_ascii=False), project['updatedAt'], 'projects', PROJECT_ID),
)
db.commit()

# verify
c.execute(
    "SELECT payload FROM novel_records WHERE collection=? AND id=?",
    ('projects', PROJECT_ID),
)
v = json.loads(c.fetchone()[0])
print(f"updated: revision={v.get('revision')} textModel={v.get('settings',{}).get('textModel')} (was {old_model}@rev{old_rev})")
db.close()

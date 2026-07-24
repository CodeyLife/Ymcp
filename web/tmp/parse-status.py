"""解析 novel_status 输出，提取项目 settings.textModel 和操作状态。"""
import json

with open(r'C:\Users\admin\AppData\Local\Temp\trae\toolcall-output\8a4308c6-2b5b-4608-a70c-eb4f741bc6a0.txt', 'r', encoding='utf-8') as f:
    raw = f.read()

# 文件格式: The MCP server responded with: [{"type":"text","text":"<json>"}]
# 提取 JSON
start = raw.find('{')
end = raw.rfind('}')
json_str = raw[start:end+1]
# 处理转义
json_str = json_str.replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\')
data = json.loads(json_str)

proj = data.get('project', {})
print('== project ==')
print(f'  id: {proj.get("id")}')
print(f'  title: {proj.get("title")}')
print(f'  status: {proj.get("status")}')
settings = proj.get('settings', {})
print(f'  settings.textModel: {settings.get("textModel")!r}')
print(f'  settings.targetWords: {settings.get("targetWords")}')

ops = data.get('operations', [])
print(f'\n== operations: {len(ops)} ==')
for op in ops:
    print(f'  {op.get("id")[:8]}.. kind={op.get("kind")} status={op.get("status")} attempt={op.get("attempt")}')

# nextActions
na = data.get('nextActions', [])
print(f'\n== nextActions: {len(na)} ==')
for a in na[:5]:
    print(f'  type={a.get("type")} reason={a.get("reason","")[:80]}')

# pending
pending = data.get('pendingChanges', [])
print(f'\n== pendingChanges: {len(pending)} ==')

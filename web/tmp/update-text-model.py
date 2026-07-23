#!/usr/bin/env python3
"""通过 mutation API 更新 project.settings.textModel = gpt-5-5"""
import json
import sys
import urllib.request

PROJECT_ID = "99328e42-f08b-49ac-b867-67690963b2e7"
URL = f"http://127.0.0.1:4766/v1/projects/{PROJECT_ID}/mutations"

# 读取当前完整 project 记录
with open("tmp/project-full.json", "r", encoding="utf-8") as f:
    project = json.load(f)

# 期望的 revision（当前为 3）
expected_revision = project["revision"]

# 更新 settings.textModel 为 gpt-5-5
project["settings"]["textModel"] = "gpt-5-5"

# 构造 mutation 命令
mutation_command = {
    "actor": {
        "type": "user",
        "id": "goal-loop-6-model-enforce"
    },
    "mutations": [
        {
            "collection": "projects",
            "id": PROJECT_ID,
            "expectedRevision": expected_revision,
            "type": "put",
            "value": project
        }
    ]
}

try:
    req = urllib.request.Request(
        URL,
        data=json.dumps(mutation_command).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    # 输出更新后的 settings
    projects = (data.get("records") or {}).get("projects") or []
    if projects:
        p = projects[0]
        print(json.dumps({
            "id": p.get("id"),
            "revision": p.get("revision"),
            "settings": p.get("settings"),
            "updatedBy": p.get("updatedBy"),
            "updatedAt": p.get("updatedAt"),
        }, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2))
except urllib.error.HTTPError as e:
    body_text = e.read().decode("utf-8", errors="replace")
    print(f"HTTP {e.code}: {body_text}", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"ERR: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)

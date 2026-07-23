#!/usr/bin/env python3
"""获取 project 完整记录用于 mutation 更新 textModel=gpt-5-5"""
import json
import sys
import urllib.request

PROJECT_ID = "99328e42-f08b-49ac-b867-67690963b2e7"
URL = f"http://127.0.0.1:4766/v1/projects/{PROJECT_ID}/records"

try:
    req = urllib.request.Request(URL, method="GET")
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    projects = (data.get("records") or {}).get("projects") or []
    if not projects:
        print("ERR: no project records", file=sys.stderr)
        sys.exit(1)
    # 输出完整 project 记录
    print(json.dumps(projects[0], ensure_ascii=False, indent=2))
except Exception as e:
    print(f"ERR: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)

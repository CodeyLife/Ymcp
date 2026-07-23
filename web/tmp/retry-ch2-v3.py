#!/usr/bin/env python3
"""重试 Ch2 operation a3e39743"""
import json
import sys
import urllib.request

OP_ID = "a3e39743-4ac0-4007-b537-cce1b1c7a0d1"
URL = f"http://127.0.0.1:4766/v1/operations/{OP_ID}/retry"

payload = {
    "actor": {
        "type": "external-llm",
        "id": "goal-loop-6-model-enforce",
        "model": "gpt-5-5"
    },
    "note": "修复 project.settings.textModel=gpt-4o 问题：已通过 mutation 更新为 gpt-5-5，并重启 runtime 加载 resolveModel 兜底。重试以生成修订候选。"
}

try:
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    op = data.get("operation") or data
    print(json.dumps({
        "id": op.get("id"),
        "status": op.get("status"),
        "attempt": op.get("attempt"),
        "updatedAt": op.get("updatedAt"),
        "error": op.get("error"),
    }, ensure_ascii=False, indent=2))
except urllib.error.HTTPError as e:
    body_text = e.read().decode("utf-8", errors="replace")
    print(f"HTTP {e.code}: {body_text}", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"ERR: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)

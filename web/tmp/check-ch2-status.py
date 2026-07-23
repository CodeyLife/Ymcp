#!/usr/bin/env python3
"""检查 Ch2 operation 当前状态"""
import json
import sys
import urllib.request

OP_ID = "a3e39743-4ac0-4007-b537-cce1b1c7a0d1"
URL = f"http://127.0.0.1:4766/v1/operations/{OP_ID}"

try:
    req = urllib.request.Request(URL, method="GET")
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    print(json.dumps(data, ensure_ascii=False, indent=2))
except Exception as e:
    print(f"ERR: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)

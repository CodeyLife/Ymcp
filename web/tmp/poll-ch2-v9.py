#!/usr/bin/env python3
"""轮询 Ch2 operation 状态，每 30 秒检查一次，最多 30 分钟"""
import json
import sys
import time
import urllib.request

OP_ID = "a3e39743-4ac0-4007-b537-cce1b1c7a0d1"
URL = f"http://127.0.0.1:4766/v1/operations/{OP_ID}"
INTERVAL = 30  # seconds
MAX_DURATION = 30 * 60  # 30 minutes

start = time.time()
last_status = None
last_attempt = None

while time.time() - start < MAX_DURATION:
    try:
        req = urllib.request.Request(URL, method="GET")
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        op = data.get("operation") or data
        status = op.get("status")
        attempt = op.get("attempt")
        error = op.get("error")
        updated_at = op.get("updatedAt")

        if status != last_status or attempt != last_attempt:
            elapsed = int(time.time() - start)
            print(f"[{elapsed}s] status={status} attempt={attempt} updatedAt={updated_at}", flush=True)
            if error:
                print(f"  error: {error}", flush=True)
            last_status = status
            last_attempt = attempt

        # 终态判断
        if status == "awaiting_review":
            print("\n=== SUCCESS: awaiting_review ===", flush=True)
            # 输出 change 信息
            changes = data.get("changes") or []
            if changes:
                for c in changes:
                    print(json.dumps({
                        "changeId": c.get("id"),
                        "status": c.get("status"),
                        "title": c.get("title"),
                    }, ensure_ascii=False), flush=True)
            sys.exit(0)

        if status == "failed":
            print(f"\n=== FAILED: {error} ===", flush=True)
            sys.exit(1)

        if status == "completed":
            print("\n=== COMPLETED ===", flush=True)
            sys.exit(0)

    except Exception as e:
        print(f"[poll error] {type(e).__name__}: {e}", flush=True)

    time.sleep(INTERVAL)

print(f"\n=== TIMEOUT after {MAX_DURATION}s ===", flush=True)
sys.exit(2)

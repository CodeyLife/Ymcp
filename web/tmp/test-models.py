#!/usr/bin/env python3
"""测试不同模型的返回情况"""
import json
import sys
import urllib.request

BASE_URL = "https://gpt.eromaa.com/v1"
API_KEY = "toolkeysec"

models_to_test = ["gpt-5-5", "gpt-5", "claude-3-5-sonnet"]

for model in models_to_test:
    print(f"=== {model} ===")
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "说一个字：好"}],
        "temperature": 0.7,
        "stream": False,
    }
    try:
        req = urllib.request.Request(
            f"{BASE_URL}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json", "authorization": f"Bearer {API_KEY}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        choice = data.get("choices", [{}])[0]
        msg = choice.get("message", {})
        content = msg.get("content", "")
        finish = choice.get("finish_reason", "")
        usage = data.get("usage", {})
        print(f"  model: {data.get('model')}")
        print(f"  finish: {finish}, tokens: {usage.get('completion_tokens', 'N/A')}")
        print(f"  content: {repr(content[:100])}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"  HTTP {e.code}: {body[:200]}")
    except Exception as e:
        print(f"  ERR: {type(e).__name__}: {e}")
    print()

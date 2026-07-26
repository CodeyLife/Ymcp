#!/usr/bin/env python3
"""直接测试 gpt-5-5 模型是否能返回内容"""
import json
import sys
import urllib.request

# 从环境获取 API 配置
BASE_URL = "https://chat.yujin8.top/v1"
API_KEY = None

# 尝试从 .env 读取
import os
from pathlib import Path
env_file = Path(".env")
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if line.startswith("VITE_DEFAULT_API_KEY="):
            API_KEY = line.split("=", 1)[1].strip().strip('"').strip("'")
        elif line.startswith("YMCP_API_KEY="):
            API_KEY = line.split("=", 1)[1].strip().strip('"').strip("'")

if not API_KEY:
    API_KEY = "toolkeysec"  # from .env.local

print(f"API Key: {API_KEY[:8]}...{API_KEY[-4:]}")
print(f"Base URL: {BASE_URL}")
print()

# 测试 1: 简单聊天
print("=== Test 1: Simple chat with gpt-5-5 ===")
payload = {
    "model": "gpt-5-5",
    "messages": [{"role": "user", "content": "请用一句话描述修仙世界中灵气的作用。"}],
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
    print(f"model: {data.get('model')}")
    print(f"finish_reason: {finish}")
    print(f"completion_tokens: {usage.get('completion_tokens', 'N/A')}")
    print(f"content: {repr(content[:200])}")
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8", errors="replace")
    print(f"HTTP {e.code}: {body[:500]}")
except Exception as e:
    print(f"ERR: {type(e).__name__}: {e}")

print()

# 测试 2: 带 max_tokens
print("=== Test 2: With max_tokens=4096 ===")
payload2 = {
    "model": "gpt-5-5",
    "messages": [{"role": "user", "content": "请用一句话描述修仙世界中灵气的作用。"}],
    "temperature": 0.7,
    "max_tokens": 4096,
    "stream": False,
}
try:
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=json.dumps(payload2).encode("utf-8"),
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
    print(f"model: {data.get('model')}")
    print(f"finish_reason: {finish}")
    print(f"completion_tokens: {usage.get('completion_tokens', 'N/A')}")
    print(f"content: {repr(content[:200])}")
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8", errors="replace")
    print(f"HTTP {e.code}: {body[:500]}")
except Exception as e:
    print(f"ERR: {type(e).__name__}: {e}")

print()

# 测试 3: 带 response_format (JSON schema)
print("=== Test 3: With response_format JSON schema ===")
payload3 = {
    "model": "gpt-5-5",
    "messages": [
        {"role": "system", "content": "只输出符合 JSON Schema 的 JSON。"},
        {"role": "user", "content": "生成一个包含 title 和 summary 字段的 JSON，描述修仙世界。"}
    ],
    "temperature": 0.5,
    "response_format": {"type": "json_schema", "json_schema": {"name": "test", "strict": True, "schema": {"type": "object", "properties": {"title": {"type": "string"}, "summary": {"type": "string"}}, "required": ["title", "summary"], "additionalProperties": False}}},
    "stream": False,
}
try:
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=json.dumps(payload3).encode("utf-8"),
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
    print(f"model: {data.get('model')}")
    print(f"finish_reason: {finish}")
    print(f"completion_tokens: {usage.get('completion_tokens', 'N/A')}")
    print(f"content: {repr(content[:300])}")
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8", errors="replace")
    print(f"HTTP {e.code}: {body[:500]}")
except Exception as e:
    print(f"ERR: {type(e).__name__}: {e}")

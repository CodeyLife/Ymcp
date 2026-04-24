from __future__ import annotations

import atexit
import contextlib
import hashlib
import importlib
import json
import logging
import ntpath
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from ymcp.contracts.common import ToolStatus
from ymcp.contracts.memory import MemoryArtifacts, MemoryResult
from ymcp.core.result import build_meta, build_next_action, build_risk

MEMORY_HOST_CONTROLS = ["调用", "展示", "后续决策", "权限控制", "敏感信息判断"]
LOGGER = logging.getLogger("ymcp.memory")
TRACE_MEMORY_ENV = "YMCP_TRACE_MEMORY"
MEMPALACE_MCP_TIMEOUT_ENV = "YMCP_MEMPALACE_MCP_TIMEOUT_SECONDS"
MEMPALACE_MCP_MODULE = "mempalace.mcp_server"
DEFAULT_MCP_TIMEOUT_SECONDS = 15.0
DEFAULT_MEMORY_WING = "personal"
DEFAULT_MEMORY_ROOM = "ymcp"
DEFAULT_WING_ENV = "YMCP_DEFAULT_WING"
PROJECT_AWARE_WING_TOOLS = {"mempalace_add_drawer", "mempalace_search", "mempalace_list_drawers", "mempalace_list_rooms"}
PROJECT_CONTEXT_KEYS = ("project_id", "project_root")

class MempalaceRelayError(RuntimeError):
    """Base error for relay transport failures."""


class MempalaceRelayProtocolError(MempalaceRelayError):
    def __init__(self, code: int | None, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class _MempalaceMcpRelayClient:
    def __init__(self, palace_path: str | None = None):
        self.palace_path = os.path.abspath(os.path.expanduser(palace_path)) if palace_path else None
        self.process: subprocess.Popen[str] | None = None
        self._request_counter = 0
        self._io_lock = threading.Lock()
        self._start()

    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.setdefault("PYTHONUTF8", "1")
        env.setdefault("PYTHONIOENCODING", "utf-8")
        if self.palace_path:
            env["MEMPALACE_PALACE_PATH"] = self.palace_path
        return env

    def _command(self) -> list[str]:
        return [sys.executable, "-X", "utf8", "-m", MEMPALACE_MCP_MODULE]

    def _timeout_seconds(self) -> float:
        raw = os.getenv(MEMPALACE_MCP_TIMEOUT_ENV, "").strip()
        if not raw:
            return DEFAULT_MCP_TIMEOUT_SECONDS
        try:
            return max(1.0, float(raw))
        except ValueError:
            return DEFAULT_MCP_TIMEOUT_SECONDS

    def _start(self) -> None:
        if self.process is not None and self.process.poll() is None:
            return
        command = self._command()
        memory_log_kv(
            "memory_mcp_relay_start",
            command=" ".join(command),
            palace_path=self.palace_path,
        )
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            bufsize=1,
            env=self._env(),
        )
        self._request_counter = 0
        self.request(
            "initialize",
            {
                "clientInfo": {"name": "ymcp", "version": "0.2.1"},
                "capabilities": {},
            },
        )

    def is_alive(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def close(self) -> None:
        process = self.process
        self.process = None
        if process is None:
            return
        with contextlib.suppress(Exception):
            if process.stdin:
                process.stdin.close()
        if process.poll() is None:
            with contextlib.suppress(Exception):
                process.terminate()
            with contextlib.suppress(Exception):
                process.wait(timeout=2)
        if process.poll() is None:
            with contextlib.suppress(Exception):
                process.kill()
        memory_log_kv("memory_mcp_relay_closed", palace_path=self.palace_path)

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.process is None or self.process.poll() is not None:
            raise MempalaceRelayError("MemPalace MCP relay process is not running")
        if self.process.stdin is None or self.process.stdout is None:
            raise MempalaceRelayError("MemPalace MCP relay pipes are unavailable")

        with self._io_lock:
            self._request_counter += 1
            request_id = self._request_counter
            payload = {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params or {},
            }
            try:
                self.process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                self.process.stdin.flush()
            except OSError as exc:
                self.close()
                raise MempalaceRelayError(f"Failed to write to MemPalace MCP relay: {exc}") from exc

            deadline = time.monotonic() + self._timeout_seconds()
            while True:
                if time.monotonic() > deadline:
                    self.close()
                    raise MempalaceRelayError(f"Timed out waiting for MemPalace MCP response: {method}")
                line = self.process.stdout.readline()
                if not line:
                    if self.process.poll() is not None:
                        self.close()
                        raise MempalaceRelayError(
                            f"MemPalace MCP relay exited with code {self.process.returncode} while handling {method}"
                        )
                    continue
                try:
                    response = json.loads(line)
                except json.JSONDecodeError as exc:
                    self.close()
                    raise MempalaceRelayError(f"Invalid JSON from MemPalace MCP relay: {line!r}") from exc
                if response.get("id") != request_id:
                    continue
                error = response.get("error")
                if error:
                    raise MempalaceRelayProtocolError(error.get("code"), error.get("message", "Unknown MCP error"))
                return response.get("result") or {}


_MCP_RELAY_CLIENT_LOCK = threading.Lock()
_MCP_RELAY_CLIENT: _MempalaceMcpRelayClient | None = None
_MCP_RELAY_CLIENT_PALACE_PATH: str | None = None


def memory_trace_enabled() -> bool:
    value = os.getenv(TRACE_MEMORY_ENV, "")
    return value.strip().lower() in {"1", "true", "yes", "on", "debug"}



def memory_log_kv(event: str, **fields: Any) -> None:
    if not memory_trace_enabled():
        return
    payload = {"event": event, **fields}
    parts = []
    for key, value in payload.items():
        if value is None:
            continue
        text = str(value).replace("\r", "\\r").replace("\n", "\\n")
        if any(ch.isspace() for ch in text):
            text = repr(text)
        parts.append(f"{key}={text}")
    LOGGER.info(" ".join(parts))



def build_memory_request_id() -> str:
    return uuid.uuid4().hex[:12]



def _preview_text(value: Any, limit: int = 80) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    text = text[:limit]
    return text + ("…" if len(str(value).strip()) > limit else "")



def _short_hash(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    if not text:
        return None
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]



def _safe_payload_summary(kwargs: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for key in ("query", "content", "context"):
        value = kwargs.get(key)
        if value is None:
            continue
        payload[f"{key}_length"] = len(str(value))
        payload[f"{key}_hash"] = _short_hash(value)
        preview = _preview_text(value)
        if preview is not None:
            payload[f"{key}_preview"] = preview
    for key in ("limit", "max_distance", "min_similarity", "source_file", "added_by", "drawer_id", "wing", "room", "project_id", "project_root"):
        value = kwargs.get(key)
        if value is not None:
            payload[key] = value
    return payload



def _slugify_wing(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if not text:
        return None
    parts: list[str] = []
    previous_dash = False
    for char in text:
        if char.isascii() and char.isalnum():
            parts.append(char)
            previous_dash = False
            continue
        if char in {"-", "_"}:
            parts.append(char)
            previous_dash = False
            continue
        if previous_dash:
            continue
        parts.append("-")
        previous_dash = True
    slug = "".join(parts).strip("-_")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or None



def _derive_wing_from_project_root(project_root: Any) -> str | None:
    raw = str(project_root or "").strip()
    if not raw:
        return None
    expanded = str(Path(raw).expanduser())
    name = ntpath.basename(expanded.rstrip("\\/")) or Path(expanded).name
    return _slugify_wing(name)



def _resolve_memory_wing(tool_name: str, kwargs: dict[str, Any]) -> tuple[str | None, str | None]:
    explicit_wing = kwargs.get("wing")
    if explicit_wing is not None and str(explicit_wing).strip():
        return str(explicit_wing).strip(), "explicit"

    project_id = kwargs.get("project_id")
    resolved_from_project_id = _slugify_wing(project_id)
    if resolved_from_project_id:
        return resolved_from_project_id, "project_id"

    resolved_from_project_root = _derive_wing_from_project_root(kwargs.get("project_root"))
    if resolved_from_project_root:
        return resolved_from_project_root, "project_root"

    env_default = _slugify_wing(os.getenv(DEFAULT_WING_ENV, ""))
    if env_default:
        return env_default, "env"

    if tool_name in PROJECT_AWARE_WING_TOOLS:
        return DEFAULT_MEMORY_WING, "fallback"
    return None, None



def _prepare_memory_kwargs(tool_name: str, kwargs: dict[str, Any]) -> tuple[dict[str, Any], str | None, str | None]:
    prepared = dict(kwargs)
    resolved_wing, wing_source = _resolve_memory_wing(tool_name, prepared)
    if resolved_wing and tool_name in PROJECT_AWARE_WING_TOOLS and not prepared.get("wing"):
        prepared["wing"] = resolved_wing
    for key in PROJECT_CONTEXT_KEYS:
        prepared.pop(key, None)
    return prepared, resolved_wing, wing_source



def _normalize_palace_path(palace_path: str | None) -> str | None:
    if palace_path:
        return os.path.abspath(os.path.expanduser(palace_path))
    return mempalace_palace_path()



def _close_mempalace_mcp_relay_client() -> None:
    global _MCP_RELAY_CLIENT, _MCP_RELAY_CLIENT_PALACE_PATH
    with _MCP_RELAY_CLIENT_LOCK:
        client = _MCP_RELAY_CLIENT
        _MCP_RELAY_CLIENT = None
        _MCP_RELAY_CLIENT_PALACE_PATH = None
    if client is not None:
        client.close()



def _get_mempalace_mcp_relay_client(palace_path: str | None = None) -> _MempalaceMcpRelayClient:
    global _MCP_RELAY_CLIENT, _MCP_RELAY_CLIENT_PALACE_PATH
    resolved_palace_path = os.path.abspath(os.path.expanduser(palace_path)) if palace_path else None
    with _MCP_RELAY_CLIENT_LOCK:
        if (
            _MCP_RELAY_CLIENT is not None
            and _MCP_RELAY_CLIENT.is_alive()
            and _MCP_RELAY_CLIENT_PALACE_PATH == resolved_palace_path
        ):
            return _MCP_RELAY_CLIENT
        stale = _MCP_RELAY_CLIENT
        _MCP_RELAY_CLIENT = None
        _MCP_RELAY_CLIENT_PALACE_PATH = None
    if stale is not None:
        stale.close()
    client = _MempalaceMcpRelayClient(resolved_palace_path)
    with _MCP_RELAY_CLIENT_LOCK:
        _MCP_RELAY_CLIENT = client
        _MCP_RELAY_CLIENT_PALACE_PATH = resolved_palace_path
    return client


atexit.register(_close_mempalace_mcp_relay_client)



def _mempalace_tool_name(function_name: str) -> str:
    if function_name.startswith("mempalace_"):
        return function_name
    if function_name.startswith("tool_"):
        return f"mempalace_{function_name[5:]}"
    return function_name


def mempalace_version() -> str | None:
    try:
        version_module = importlib.import_module("mempalace.version")
        return getattr(version_module, "__version__", None)
    except Exception:
        return None



def mempalace_palace_path() -> str | None:
    try:
        config_module = importlib.import_module("mempalace.config")
        return config_module.MempalaceConfig().palace_path
    except Exception:
        return None



def _derive_items(operation: str, raw: dict[str, Any]) -> tuple[int, list[dict[str, Any]], str | None]:
    if operation in {"search", "mempalace_search"}:
        results = raw.get("results") or raw.get("matches") or []
        count = len(results)
        message = "未找到相关记忆。" if count == 0 else f"找到 {count} 条相关记忆。"
        return count, results, message
    if operation in {
        "list_wings",
        "list_rooms",
        "list_tunnels",
        "taxonomy",
        "status",
        "mempalace_list_wings",
        "mempalace_list_rooms",
        "mempalace_list_tunnels",
        "mempalace_get_taxonomy",
        "mempalace_status",
    }:
        for key in ("wings", "rooms", "tunnels"):
            value = raw.get(key)
            if isinstance(value, dict):
                items = [{"name": k, "value": v} for k, v in value.items()]
                return len(items), items, None
            if isinstance(value, list):
                return len(value), value, None
        return (raw.get("total_drawers") or 0), [], None
    if isinstance(raw, dict):
        if "results" in raw and isinstance(raw["results"], list):
            return len(raw["results"]), raw["results"], None
        if "tunnels" in raw and isinstance(raw["tunnels"], list):
            return len(raw["tunnels"]), raw["tunnels"], None
        return (1 if raw else 0), ([raw] if raw else []), None
    return 0, [], None



def _normalize_raw(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    return {"value": raw}



def _status_from_raw(raw: dict[str, Any]) -> ToolStatus:
    if raw.get("success") is False or raw.get("error"):
        return ToolStatus.ERROR
    if raw.get("blocked"):
        return ToolStatus.BLOCKED
    return ToolStatus.OK



def _summary(operation: str, raw: dict[str, Any], status: ToolStatus) -> str:
    if status is ToolStatus.ERROR:
        return f"记忆操作 {operation} 失败：{raw.get('error', '未知错误')}"
    if status is ToolStatus.BLOCKED:
        return f"记忆操作 {operation} 当前不可用。"
    return f"已完成 MemPalace 工具调用：{operation}。"



def memory_result(tool_name: str, operation: str, raw: Any) -> MemoryResult:
    raw_dict = _normalize_raw(raw)
    status = _status_from_raw(raw_dict)
    count, items, message = _derive_items(operation, raw_dict)
    return MemoryResult(
        status=status,
        summary=_summary(operation, raw_dict, status),
        assumptions=["Ymcp 会优先使用宿主提供的项目上下文解析 wing，缺失时才回退到 personal。", "宿主负责判断哪些内容适合写入长期记忆。"],
        next_actions=[build_next_action("查看结果", "由宿主展示或继续处理 MemPalace 返回的原始结果。")],
        risks=[build_risk("记忆写入是持久化副作用。", "写入前应避免保存密钥、隐私或未经确认的敏感信息。")],
        meta=build_meta(tool_name, "ymcp.contracts.memory.MemoryResult", host_controls=MEMORY_HOST_CONTROLS),
        artifacts=MemoryArtifacts(operation=operation, count=count, items=items, message=message, raw=raw_dict),
    )



def limit_memory_result_items(result: MemoryResult, limit: int) -> MemoryResult:
    limited_items = result.artifacts.items[:limit]
    result.artifacts.items = limited_items
    result.artifacts.count = len(limited_items)
    if isinstance(result.artifacts.raw, dict):
        if isinstance(result.artifacts.raw.get("results"), list):
            result.artifacts.raw["results"] = result.artifacts.raw["results"][:limit]
        if isinstance(result.artifacts.raw.get("matches"), list):
            result.artifacts.raw["matches"] = result.artifacts.raw["matches"][:limit]
        if isinstance(result.artifacts.raw.get("tunnels"), list):
            result.artifacts.raw["tunnels"] = result.artifacts.raw["tunnels"][:limit]
    return result



def capability_blocked(tool_name: str, operation: str, function_name: str) -> MemoryResult:
    return MemoryResult(
        status=ToolStatus.BLOCKED,
        summary=f"当前 MemPalace 版本未提供 {function_name}，无法执行 {operation}。",
        assumptions=["不同 MemPalace 版本可能提供不同高级能力。"],
        next_actions=[build_next_action("检查版本", "运行 ymcp doctor --json 查看 MemPalace 版本。")],
        risks=[build_risk("高级能力不可用。", "升级 mempalace 或改用基础 mempalace_add_drawer/mempalace_search 工具。")],
        meta=build_meta(tool_name, "ymcp.contracts.memory.MemoryResult", host_controls=MEMORY_HOST_CONTROLS),
        artifacts=MemoryArtifacts(operation=operation, raw={"blocked": True, "missing_function": function_name}),
    )



def _extract_mcp_content_text(result: dict[str, Any]) -> str:
    content = result.get("content") or []
    for item in content:
        if item.get("type") == "text":
            return item.get("text", "")
    raise MempalaceRelayError("MemPalace MCP relay returned no text content")



def _call_mempalace_tool_via_mcp(
    tool_name: str,
    operation: str,
    *args: Any,
    palace_path: str | None = None,
    request_id: str | None = None,
    resolved_wing: str | None = None,
    wing_source: str | None = None,
    **kwargs: Any,
) -> MemoryResult:
    if args:
        raise TypeError("MCP relay transport only supports keyword arguments")
    resolved_palace_path = _normalize_palace_path(palace_path)
    request_id = request_id or build_memory_request_id()
    mcp_tool_name = tool_name
    tool_args = dict(kwargs)
    client = _get_mempalace_mcp_relay_client(resolved_palace_path)
    memory_log_kv(
        "memory_relay_tool_resolved",
        tool_name=tool_name,
        operation=operation,
        request_id=request_id,
        mcp_tool_name=mcp_tool_name,
        palace_path=resolved_palace_path,
        resolved_wing=resolved_wing,
        wing_source=wing_source,
    )
    result = client.request("tools/call", {"name": mcp_tool_name, "arguments": tool_args})
    text = _extract_mcp_content_text(result)
    try:
        raw = json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        raise MempalaceRelayError(f"MemPalace MCP relay returned non-JSON content: {text!r}") from exc
    return memory_result(tool_name, operation, raw)





def run_memory_operation(
    tool_name: str,
    operation: str,
    *,
    result_limit: int | None = None,
    **kwargs: Any,
) -> MemoryResult:
    result = call_mempalace_tool(tool_name, operation, **kwargs)
    if result_limit is not None:
        result = limit_memory_result_items(result, result_limit)
    return result


def execute_memory_operation(tool_name: str, **kwargs: Any) -> MemoryResult:
    result_limit = kwargs.get("limit") if tool_name in {"mempalace_search", "mempalace_list_drawers"} else None
    return run_memory_operation(tool_name, tool_name, result_limit=result_limit, **kwargs)



def memory_result_to_mcp_payload(
    result: MemoryResult,
    *,
    handler_name: str,
    request_id: str,
    started_at: float,
) -> dict[str, Any]:
    duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
    memory_log_kv(
        f"{handler_name}_end",
        request_id=request_id,
        pid=os.getpid(),
        duration_ms=duration_ms,
        status=result.status.value,
        result_count=result.artifacts.count,
        message=result.artifacts.message,
    )
    payload = result.to_mcp_result()
    memory_log_kv(
        f"{handler_name}_return",
        request_id=request_id,
        pid=os.getpid(),
        payload_status=payload.get("status"),
        payload_keys=",".join(sorted(payload.keys())),
        artifacts_count=payload.get("artifacts", {}).get("count"),
    )
    return payload


def call_mempalace_tool(
    tool_name: str,
    operation: str,
    *args: Any,
    palace_path: str | None = None,
    request_id: str | None = None,
    **kwargs: Any,
) -> MemoryResult:
    resolved_palace_path = _normalize_palace_path(palace_path)
    request_id = request_id or build_memory_request_id()
    pid = os.getpid()
    started_at = time.perf_counter()
    prepared_kwargs, resolved_wing, wing_source = _prepare_memory_kwargs(tool_name, kwargs)
    memory_log_kv(
        "memory_call_start",
        tool_name=tool_name,
        operation=operation,
        transport="mcp_relay",
        request_id=request_id,
        pid=pid,
        palace_path=resolved_palace_path,
        resolved_wing=resolved_wing,
        wing_source=wing_source,
        **_safe_payload_summary(prepared_kwargs),
    )

    try:
        result = _call_mempalace_tool_via_mcp(
            tool_name,
            operation,
            *args,
            palace_path=palace_path,
            request_id=request_id,
            resolved_wing=resolved_wing,
            wing_source=wing_source,
            **prepared_kwargs,
        )
        duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
        memory_log_kv(
            "memory_call_end",
            tool_name=tool_name,
            operation=operation,
            transport="mcp_relay",
            request_id=request_id,
            pid=pid,
            duration_ms=duration_ms,
            status=result.status.value,
            result_count=result.artifacts.count,
            message=result.artifacts.message,
            resolved_wing=resolved_wing,
            wing_source=wing_source,
        )
        return result
    except MempalaceRelayProtocolError as exc:
        if exc.code == -32601:
            result = capability_blocked(tool_name, operation, tool_name)
            duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
            memory_log_kv(
                "memory_call_blocked",
                tool_name=tool_name,
                operation=operation,
                transport="mcp_relay",
                request_id=request_id,
                pid=pid,
                duration_ms=duration_ms,
                status=result.status.value,
                error_type="missing_function",
                error_message=tool_name,
            )
            return result
        memory_log_kv(
            "memory_relay_error",
            tool_name=tool_name,
            operation=operation,
            transport="mcp_relay",
            request_id=request_id,
            pid=pid,
            error_type=type(exc).__name__,
            error_message=str(exc),
        )
        raise
    except MempalaceRelayError as exc:
        memory_log_kv(
            "memory_relay_error",
            tool_name=tool_name,
            operation=operation,
            transport="mcp_relay",
            request_id=request_id,
            pid=pid,
            error_type=type(exc).__name__,
            error_message=str(exc),
        )
        raise
    except Exception as exc:
        duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
        memory_log_kv(
            "memory_call_error",
            tool_name=tool_name,
            operation=operation,
            request_id=request_id,
            pid=pid,
            duration_ms=duration_ms,
            error_type=type(exc).__name__,
            error_message=str(exc),
        )
        raise

from __future__ import annotations

import atexit
import contextlib
import hashlib
import importlib
import json
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any

from ymcp.contracts.common import ToolStatus
from ymcp.contracts.memory import DEFAULT_MEMORY_ROOM, DEFAULT_MEMORY_WING, MemoryArtifacts, MemoryResult
from ymcp.core.result import build_meta, build_next_action, build_risk

MEMORY_HOST_CONTROLS = ["调用", "展示", "后续决策", "权限控制", "敏感信息判断"]
LOGGER = logging.getLogger("ymcp.memory")
TRACE_MEMORY_ENV = "YMCP_TRACE_MEMORY"
MEMPALACE_MCP_TIMEOUT_ENV = "YMCP_MEMPALACE_MCP_TIMEOUT_SECONDS"
MEMPALACE_MCP_MODULE = "mempalace.mcp_server"
DEFAULT_MCP_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True)
class MemoryOperationSpec:
    tool_name: str
    operation: str
    function_name: str
    default_limit_param: str | None = None


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
        if self.palace_path:
            env["MEMPALACE_PALACE_PATH"] = self.palace_path
        return env

    def _command(self) -> list[str]:
        return [sys.executable, "-m", MEMPALACE_MCP_MODULE]

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
    for key in ("limit", "max_distance", "min_similarity", "source_file", "added_by", "drawer_id"):
        value = kwargs.get(key)
        if value is not None:
            payload[key] = value
    return payload



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


MEMORY_OPERATION_SPECS: dict[str, MemoryOperationSpec] = {
    "memory_store": MemoryOperationSpec("memory_store", "store", "tool_add_drawer"),
    "memory_search": MemoryOperationSpec("memory_search", "search", "tool_search"),
    "memory_get": MemoryOperationSpec("memory_get", "get", "tool_get_drawer"),
    "memory_update": MemoryOperationSpec("memory_update", "update", "tool_update_drawer"),
    "memory_delete": MemoryOperationSpec("memory_delete", "delete", "tool_delete_drawer"),
    "memory_status": MemoryOperationSpec("memory_status", "status", "tool_status"),
    "memory_list_wings": MemoryOperationSpec("memory_list_wings", "list_wings", "tool_list_wings"),
    "memory_list_rooms": MemoryOperationSpec("memory_list_rooms", "list_rooms", "tool_list_rooms"),
    "memory_taxonomy": MemoryOperationSpec("memory_taxonomy", "taxonomy", "tool_get_taxonomy"),
    "memory_check_duplicate": MemoryOperationSpec("memory_check_duplicate", "check_duplicate", "tool_check_duplicate"),
    "memory_reconnect": MemoryOperationSpec("memory_reconnect", "reconnect", "tool_reconnect"),
    "memory_graph_stats": MemoryOperationSpec("memory_graph_stats", "graph_stats", "tool_graph_stats"),
    "memory_graph_query": MemoryOperationSpec("memory_graph_query", "graph_query", "tool_kg_query", default_limit_param="limit"),
    "memory_graph_traverse": MemoryOperationSpec("memory_graph_traverse", "graph_traverse", "tool_traverse_graph"),
    "memory_kg_add": MemoryOperationSpec("memory_kg_add", "kg_add", "tool_kg_add"),
    "memory_kg_timeline": MemoryOperationSpec("memory_kg_timeline", "kg_timeline", "tool_kg_timeline", default_limit_param="limit"),
    "memory_kg_invalidate": MemoryOperationSpec("memory_kg_invalidate", "kg_invalidate", "tool_kg_invalidate"),
    "memory_create_tunnel": MemoryOperationSpec("memory_create_tunnel", "create_tunnel", "tool_create_tunnel"),
    "memory_list_tunnels": MemoryOperationSpec("memory_list_tunnels", "list_tunnels", "tool_list_tunnels"),
    "memory_find_tunnels": MemoryOperationSpec("memory_find_tunnels", "find_tunnels", "tool_find_tunnels", default_limit_param="limit"),
    "memory_follow_tunnels": MemoryOperationSpec("memory_follow_tunnels", "follow_tunnels", "tool_follow_tunnels"),
    "memory_delete_tunnel": MemoryOperationSpec("memory_delete_tunnel", "delete_tunnel", "tool_delete_tunnel"),
    "memory_diary_write": MemoryOperationSpec("memory_diary_write", "diary_write", "tool_diary_write"),
    "memory_diary_read": MemoryOperationSpec("memory_diary_read", "diary_read", "tool_diary_read"),
}


def get_memory_operation_spec(tool_name: str) -> MemoryOperationSpec:
    return MEMORY_OPERATION_SPECS[tool_name]



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
    if operation == "search":
        results = raw.get("results") or raw.get("matches") or []
        count = len(results)
        message = "未找到相关记忆。" if count == 0 else f"找到 {count} 条相关记忆。"
        return count, results, message
    if operation in {"list_wings", "list_rooms", "list_tunnels", "taxonomy", "status"}:
        for key in ("wings", "rooms", "tunnels"):
            value = raw.get(key)
            if isinstance(value, dict):
                items = [{"name": k, "value": v} for k, v in value.items()]
                return len(items), items, None
            if isinstance(value, list):
                return len(value), value, None
        return (raw.get("total_drawers") or 0), [], None
    if operation in {"get", "update", "delete", "store", "check_duplicate", "reconnect", "graph_stats", "graph_query", "graph_traverse", "kg_add", "kg_timeline", "kg_invalidate", "create_tunnel", "find_tunnels", "follow_tunnels", "delete_tunnel", "diary_write", "diary_read"}:
        if isinstance(raw, dict):
            if "results" in raw and isinstance(raw["results"], list):
                return len(raw["results"]), raw["results"], None
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
    if operation == "store":
        return f"已请求保存记忆：{raw.get('drawer_id', raw.get('entry_id', '未返回 ID'))}"
    if operation == "search":
        count = len(raw.get("results", raw.get("matches", []))) if isinstance(raw, dict) else 0
        return f"已完成记忆搜索，返回 {count} 条候选结果。"
    return f"已完成记忆操作：{operation}。"



def memory_result(tool_name: str, operation: str, raw: Any, *, wing: str | None = DEFAULT_MEMORY_WING, room: str | None = DEFAULT_MEMORY_ROOM) -> MemoryResult:
    raw_dict = _normalize_raw(raw)
    status = _status_from_raw(raw_dict)
    count, items, message = _derive_items(operation, raw_dict)
    return MemoryResult(
        status=status,
        summary=_summary(operation, raw_dict, status),
        assumptions=["默认使用全局个人记忆空间。", "宿主负责判断哪些内容适合写入长期记忆。"],
        next_actions=[build_next_action("查看结果", "由宿主展示或继续处理 MemPalace 返回的原始结果。")],
        risks=[build_risk("记忆写入是持久化副作用。", "写入前应避免保存密钥、隐私或未经确认的敏感信息。")],
        meta=build_meta(tool_name, "ymcp.contracts.memory.MemoryResult", host_controls=MEMORY_HOST_CONTROLS),
        artifacts=MemoryArtifacts(operation=operation, wing=wing, room=room, count=count, items=items, message=message, raw=raw_dict),
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
    if result.artifacts.operation == "search":
        result.summary = f"已完成记忆搜索，返回 {len(limited_items)} 条候选结果。"
        result.artifacts.message = "未找到相关记忆。" if not limited_items else f"找到 {len(limited_items)} 条相关记忆。"
    return result



def capability_blocked(tool_name: str, operation: str, function_name: str) -> MemoryResult:
    return MemoryResult(
        status=ToolStatus.BLOCKED,
        summary=f"当前 MemPalace 版本未提供 {function_name}，无法执行 {operation}。",
        assumptions=["不同 MemPalace 版本可能提供不同高级能力。"],
        next_actions=[build_next_action("检查版本", "运行 ymcp doctor --json 查看 MemPalace 版本。")],
        risks=[build_risk("高级能力不可用。", "升级 mempalace 或改用基础 memory_store/memory_search 工具。")],
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
    function_name: str,
    *args: Any,
    wing: str | None = DEFAULT_MEMORY_WING,
    room: str | None = DEFAULT_MEMORY_ROOM,
    palace_path: str | None = None,
    request_id: str | None = None,
    **kwargs: Any,
) -> MemoryResult:
    if args:
        raise TypeError("MCP relay transport only supports keyword arguments")
    resolved_palace_path = _normalize_palace_path(palace_path)
    request_id = request_id or build_memory_request_id()
    mcp_tool_name = _mempalace_tool_name(function_name)
    tool_args = dict(kwargs)
    if wing is not None and "wing" not in tool_args:
        tool_args["wing"] = wing
    if room is not None and "room" not in tool_args:
        tool_args["room"] = room
    client = _get_mempalace_mcp_relay_client(resolved_palace_path)
    memory_log_kv(
        "memory_relay_tool_resolved",
        tool_name=tool_name,
        operation=operation,
        request_id=request_id,
        mcp_tool_name=mcp_tool_name,
        palace_path=resolved_palace_path,
    )
    result = client.request("tools/call", {"name": mcp_tool_name, "arguments": tool_args})
    text = _extract_mcp_content_text(result)
    try:
        raw = json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        raise MempalaceRelayError(f"MemPalace MCP relay returned non-JSON content: {text!r}") from exc
    return memory_result(tool_name, operation, raw, wing=wing, room=room)





def run_memory_operation(
    tool_name: str,
    operation: str,
    function_name: str,
    *,
    limit: int | None = None,
    **kwargs: Any,
) -> MemoryResult:
    result = call_mempalace_tool(tool_name, operation, function_name, **kwargs)
    if limit is not None:
        result = limit_memory_result_items(result, limit)
    return result


def execute_memory_operation(tool_name: str, **kwargs: Any) -> MemoryResult:
    spec = get_memory_operation_spec(tool_name)
    limit = None
    if spec.default_limit_param and spec.default_limit_param in kwargs:
        limit = kwargs.pop(spec.default_limit_param)
    return run_memory_operation(
        spec.tool_name,
        spec.operation,
        spec.function_name,
        limit=limit,
        **kwargs,
    )



def run_memory_search_operation(
    *,
    query: str,
    limit: int = 5,
    wing: str | None = DEFAULT_MEMORY_WING,
    room: str | None = None,
    max_distance: float = 1.5,
    min_similarity: float | None = None,
    context: str | None = None,
    request_id: str | None = None,
) -> MemoryResult:
    return run_memory_operation(
        "memory_search",
        "search",
        "tool_search",
        query=query,
        limit=limit,
        wing=wing,
        room=room,
        max_distance=max_distance,
        min_similarity=min_similarity,
        context=context,
        request_id=request_id,
    )



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
    function_name: str,
    *args: Any,
    wing: str | None = DEFAULT_MEMORY_WING,
    room: str | None = DEFAULT_MEMORY_ROOM,
    palace_path: str | None = None,
    request_id: str | None = None,
    **kwargs: Any,
) -> MemoryResult:
    resolved_palace_path = _normalize_palace_path(palace_path)
    request_id = request_id or build_memory_request_id()
    pid = os.getpid()
    started_at = time.perf_counter()
    memory_log_kv(
        "memory_call_start",
        tool_name=tool_name,
        operation=operation,
        function_name=function_name,
        transport="mcp_relay",
        request_id=request_id,
        pid=pid,
        palace_path=resolved_palace_path,
        wing=wing,
        room=room,
        **_safe_payload_summary(kwargs),
    )

    try:
        result = _call_mempalace_tool_via_mcp(
            tool_name,
            operation,
            function_name,
            *args,
            wing=wing,
            room=room,
            palace_path=palace_path,
            request_id=request_id,
            **kwargs,
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
        )
        return result
    except MempalaceRelayProtocolError as exc:
        if exc.code == -32601:
            result = capability_blocked(tool_name, operation, function_name)
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
                error_message=function_name,
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

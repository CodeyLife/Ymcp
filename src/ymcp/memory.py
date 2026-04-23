from __future__ import annotations

import contextlib
import importlib
import os
import sys
from collections.abc import Callable
from typing import Any

from ymcp.contracts.common import ToolStatus
from ymcp.contracts.memory import DEFAULT_MEMORY_ROOM, DEFAULT_MEMORY_WING, MemoryArtifacts, MemoryResult
from ymcp.core.result import build_meta, build_next_action, build_risk

MEMORY_HOST_CONTROLS = ["调用", "展示", "后续决策", "权限控制", "敏感信息判断"]


@contextlib.contextmanager
def _preserve_stdout():
    python_stdout = sys.stdout
    fd_copy = None
    try:
        fd_copy = os.dup(1)
    except (OSError, AttributeError):
        fd_copy = None
    try:
        yield
    finally:
        sys.stdout = python_stdout
        if fd_copy is not None:
            try:
                os.dup2(fd_copy, 1)
                os.close(fd_copy)
            except OSError:
                pass


def _mempalace_module(palace_path: str | None = None):
    if palace_path:
        os.environ["MEMPALACE_PALACE_PATH"] = os.path.abspath(os.path.expanduser(palace_path))
    with _preserve_stdout():
        module = importlib.import_module("mempalace.mcp_server")
    if palace_path:
        # MemPalace captures config at import time; refresh it when tests/tools override palace path.
        try:
            config_module = importlib.import_module("mempalace.config")
            module._config = config_module.MempalaceConfig()  # type: ignore[attr-defined]
            module._collection_cache = None  # type: ignore[attr-defined]
            module._client_cache = None  # type: ignore[attr-defined]
        except Exception:
            pass
    return module


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
        return f"已请求保存记忆：{raw.get('drawer_id', '未返回 drawer_id')}"
    if operation == "search":
        count = len(raw.get("results", raw.get("matches", []))) if isinstance(raw, dict) else 0
        return f"已完成记忆搜索，返回 {count} 条候选结果。"
    return f"已完成记忆操作：{operation}。"


def memory_result(tool_name: str, operation: str, raw: Any, *, wing: str | None = DEFAULT_MEMORY_WING, room: str | None = DEFAULT_MEMORY_ROOM) -> MemoryResult:
    raw_dict = _normalize_raw(raw)
    status = _status_from_raw(raw_dict)
    return MemoryResult(
        status=status,
        summary=_summary(operation, raw_dict, status),
        assumptions=["默认使用全局个人记忆空间。", "宿主负责判断哪些内容适合写入长期记忆。"],
        next_actions=[build_next_action("查看结果", "由宿主展示或继续处理 MemPalace 返回的原始结果。")],
        risks=[build_risk("记忆写入是持久化副作用。", "写入前应避免保存密钥、隐私或未经确认的敏感信息。")],
        meta=build_meta(tool_name, "ymcp.contracts.memory.MemoryResult", host_controls=MEMORY_HOST_CONTROLS),
        artifacts=MemoryArtifacts(operation=operation, wing=wing, room=room, raw=raw_dict),
    )


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


def call_mempalace_tool(tool_name: str, operation: str, function_name: str, *args: Any, wing: str | None = DEFAULT_MEMORY_WING, room: str | None = DEFAULT_MEMORY_ROOM, palace_path: str | None = None, **kwargs: Any) -> MemoryResult:
    module = _mempalace_module(palace_path)
    fn: Callable[..., Any] | None = getattr(module, function_name, None)
    if fn is None:
        return capability_blocked(tool_name, operation, function_name)
    raw = fn(*args, **kwargs)
    return memory_result(tool_name, operation, raw, wing=wing, room=room)

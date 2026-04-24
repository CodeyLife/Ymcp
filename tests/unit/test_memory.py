import logging
import sys

import anyio
import pytest

from ymcp.memory import (
    MempalaceRelayError,
    MempalaceRelayProtocolError,
    capability_blocked,
    memory_result,
)


def test_memory_result_wraps_raw_response():
    result = memory_result("mempalace_status", "mempalace_status", {"total_drawers": 1})
    assert result.status.value == "ok"
    assert result.artifacts.operation == "mempalace_status"
    assert result.artifacts.raw["total_drawers"] == 1
    assert result.meta.tool_name == "mempalace_status"


def test_capability_blocked_returns_blocked_status():
    result = capability_blocked("mempalace_graph_stats", "mempalace_graph_stats", "mempalace_graph_stats")
    assert result.status.value == "blocked"
    assert result.artifacts.raw["missing_function"] == "mempalace_graph_stats"


def test_mempalace_search_empty_result_has_stable_display_fields():
    result = memory_result("mempalace_search", "mempalace_search", {"query": "不存在", "results": []})
    assert result.artifacts.count == 0
    assert result.artifacts.items == []
    assert result.artifacts.message == "未找到相关记忆。"
    assert "undefined" not in result.model_dump_json()


def test_call_mempalace_tool_prefers_mcp_relay(monkeypatch):
    from ymcp import memory

    captured = {}

    def fake_relay(tool_name, operation, *args, **kwargs):
        captured.update({
            "tool_name": tool_name,
            "operation": operation,
            **kwargs,
        })
        return memory_result("mempalace_search", "mempalace_search", {"results": []})

    monkeypatch.setattr(memory, "_call_mempalace_tool_via_mcp", fake_relay)
    monkeypatch.setattr(memory, "mempalace_palace_path", lambda: r"C:\Users\BSTECH05\.yjj")

    result = memory.call_mempalace_tool(
        "mempalace_search",
        "mempalace_search",
        query="Ymcp",
        wing="personal",
        room="ymcp",
    )
    assert captured["wing"] == "personal"
    assert captured["room"] == "ymcp"
    assert result.meta.tool_name == "mempalace_search"


def test_call_mempalace_tool_derives_wing_from_project_id(monkeypatch):
    from ymcp import memory

    captured = {}

    def fake_relay(tool_name, operation, *args, **kwargs):
        captured.update(kwargs)
        return memory_result("mempalace_add_drawer", "mempalace_add_drawer", {"saved": True})

    monkeypatch.setattr(memory, "_call_mempalace_tool_via_mcp", fake_relay)
    monkeypatch.setattr(memory, "mempalace_palace_path", lambda: r"C:\Users\BSTECH05\.yjj")

    memory.call_mempalace_tool(
        "mempalace_add_drawer",
        "mempalace_add_drawer",
        project_id="Team Ymcp",
        room="decisions",
        content="kept",
    )

    assert captured["wing"] == "team-ymcp"
    assert "project_id" not in captured
    assert "project_root" not in captured


def test_call_mempalace_tool_derives_wing_from_project_root(monkeypatch):
    from ymcp import memory

    captured = {}

    def fake_relay(tool_name, operation, *args, **kwargs):
        captured.update(kwargs)
        return memory_result("mempalace_search", "mempalace_search", {"results": []})

    monkeypatch.setattr(memory, "_call_mempalace_tool_via_mcp", fake_relay)
    monkeypatch.setattr(memory, "mempalace_palace_path", lambda: r"C:\Users\BSTECH05\.yjj")

    memory.call_mempalace_tool(
        "mempalace_search",
        "mempalace_search",
        query="Ymcp",
        project_root=r"D:\GithubProject\Ymcp",
    )

    assert captured["wing"] == "ymcp"


def test_call_mempalace_tool_raises_on_relay_error(monkeypatch):
    from ymcp import memory

    monkeypatch.setattr(
        memory,
        "_call_mempalace_tool_via_mcp",
        lambda *args, **kwargs: (_ for _ in ()).throw(MempalaceRelayError("boom")),
    )

    with pytest.raises(MempalaceRelayError):
        memory.call_mempalace_tool("mempalace_status", "mempalace_status")


def test_call_mempalace_tool_returns_blocked_on_missing_mcp_tool(monkeypatch):
    from ymcp import memory

    monkeypatch.setattr(
        memory,
        "_call_mempalace_tool_via_mcp",
        lambda *args, **kwargs: (_ for _ in ()).throw(MempalaceRelayProtocolError(-32601, "Unknown tool")),
    )

    result = memory.call_mempalace_tool("mempalace_graph_stats", "mempalace_graph_stats")
    assert result.status.value == "blocked"
    assert result.artifacts.raw["missing_function"] == "mempalace_graph_stats"


def test_call_mempalace_tool_emits_trace_logs_when_enabled(monkeypatch, caplog):
    from ymcp import memory

    monkeypatch.setenv("YMCP_TRACE_MEMORY", "1")
    monkeypatch.setattr(
        memory,
        "_call_mempalace_tool_via_mcp",
        lambda *args, **kwargs: memory_result("mempalace_search", "mempalace_search", {"results": [{"text": "ok"}]}),
    )
    monkeypatch.setattr(memory, "mempalace_palace_path", lambda: r"C:\Users\BSTECH05\.yjj")
    with caplog.at_level(logging.INFO, logger="ymcp.memory"):
        result = memory.call_mempalace_tool(
            "mempalace_search",
            "mempalace_search",
            query="Ymcp 发布流程",
            request_id="req123",
            project_id="Ymcp Project",
        )

    assert result.artifacts.count == 1
    messages = [record.getMessage() for record in caplog.records]
    assert any("event=memory_call_start" in message and "request_id=req123" in message for message in messages)
    assert any("event=memory_call_end" in message and "transport=mcp_relay" in message for message in messages)
    assert any("resolved_wing=ymcp-project" in message and "wing_source=project_id" in message for message in messages)


def test_call_mempalace_tool_trace_logs_are_disabled_by_default(monkeypatch, caplog):
    from ymcp import memory

    monkeypatch.delenv("YMCP_TRACE_MEMORY", raising=False)
    monkeypatch.setattr(
        memory,
        "_call_mempalace_tool_via_mcp",
        lambda *args, **kwargs: memory_result("mempalace_search", "mempalace_search", {"results": []}),
    )
    with caplog.at_level(logging.INFO, logger="ymcp.memory"):
        memory.call_mempalace_tool("mempalace_search", "mempalace_search", query="Ymcp")

    assert caplog.records == []


def test_mempalace_tool_name_maps_internal_functions_to_mcp_tools():
    from ymcp.memory import _mempalace_tool_name

    assert _mempalace_tool_name("tool_search") == "mempalace_search"
    assert _mempalace_tool_name("tool_add_drawer") == "mempalace_add_drawer"


def test_mempalace_relay_client_forces_utf8_mode(monkeypatch):
    from ymcp.memory import _MempalaceMcpRelayClient

    monkeypatch.setattr(_MempalaceMcpRelayClient, "_start", lambda self: None)

    client = _MempalaceMcpRelayClient()

    assert client._command() == [sys.executable, "-X", "utf8", "-m", "mempalace.mcp_server"]
    env = client._env()
    assert env["PYTHONUTF8"] == "1"
    assert env["PYTHONIOENCODING"] == "utf-8"


def test_mempalace_status_handler_emits_trace_logs(monkeypatch, caplog):
    from ymcp import server
    from ymcp.memory import memory_result

    monkeypatch.setenv("YMCP_TRACE_MEMORY", "1")

    def fake_call(*args, **kwargs):
        return memory_result("mempalace_status", "mempalace_status", {"total_drawers": 1})

    monkeypatch.setattr(server, "execute_memory_operation", fake_call)
    monkeypatch.setattr(server, "mempalace_palace_path", lambda: r"C:\Users\BSTECH05\.yjj")

    async def _run():
        app = server.create_app()
        await app.call_tool("mempalace_status", {})

    with caplog.at_level(logging.INFO, logger="ymcp.memory"):
        anyio.run(_run)

    messages = [record.getMessage() for record in caplog.records]
    assert any("event=mempalace_status_handler_start" in message for message in messages)
    assert any("event=mempalace_status_handler_end" in message for message in messages)
    assert any("event=mempalace_status_handler_return" in message for message in messages)


def test_mempalace_search_handler_emits_return_trace_logs(monkeypatch, caplog):
    from ymcp import server
    from ymcp.memory import memory_result

    monkeypatch.setenv("YMCP_TRACE_MEMORY", "1")

    def fake_call(*args, **kwargs):
        return memory_result("mempalace_search", "mempalace_search", {"query": "Ymcp", "results": []})

    monkeypatch.setattr(server, "execute_memory_operation", fake_call)
    monkeypatch.setattr(server, "mempalace_palace_path", lambda: r"C:\Users\BSTECH05\.yjj")

    async def _run():
        app = server.create_app()
        await app.call_tool("mempalace_search", {"query": "Ymcp"})

    with caplog.at_level(logging.INFO, logger="ymcp.memory"):
        anyio.run(_run)

    messages = [record.getMessage() for record in caplog.records]
    assert any("event=mempalace_search_handler_start" in message for message in messages)
    assert any("event=mempalace_search_handler_end" in message for message in messages)
    assert any("event=mempalace_search_handler_return" in message for message in messages)


def test_mempalace_search_handler_uses_mcp_backend_by_default(monkeypatch):
    from ymcp import server
    from ymcp.memory import memory_result

    called = {"tool": 0}

    def fake_tool(*args, **kwargs):
        called["tool"] += 1
        return memory_result("mempalace_search", "mempalace_search", {"query": "Ymcp", "results": []})

    monkeypatch.setattr(server, "execute_memory_operation", fake_tool)

    async def _run():
        app = server.create_app()
        await app.call_tool("mempalace_search", {"query": "Ymcp"})

    anyio.run(_run)
    assert called == {"tool": 1}

import logging

import anyio

from ymcp.memory import capability_blocked, memory_result


def test_memory_result_wraps_raw_response():
    result = memory_result("memory_status", "status", {"total_drawers": 1})
    assert result.status.value == "ok"
    assert result.artifacts.operation == "status"
    assert result.artifacts.raw["total_drawers"] == 1
    assert result.meta.tool_name == "memory_status"


def test_capability_blocked_returns_blocked_status():
    result = capability_blocked("memory_graph_stats", "graph_stats", "tool_graph_stats")
    assert result.status.value == "blocked"
    assert result.artifacts.raw["missing_function"] == "tool_graph_stats"



def test_memory_search_empty_result_has_stable_display_fields():
    result = memory_result("memory_search", "search", {"query": "不存在", "results": []})
    assert result.artifacts.count == 0
    assert result.artifacts.items == []
    assert result.artifacts.message == "未找到相关记忆。"
    assert "undefined" not in result.model_dump_json()


def test_call_mempalace_tool_passes_wing_and_room(monkeypatch):
    from ymcp import memory

    captured = {}

    class FakeModule:
        @staticmethod
        def tool_search(**kwargs):
            captured.update(kwargs)
            return {"results": [], "filters": {"wing": kwargs.get("wing"), "room": kwargs.get("room")}}

    monkeypatch.setattr(memory, "_mempalace_module", lambda palace_path=None: FakeModule)
    result = memory.call_mempalace_tool(
        "memory_search",
        "search",
        "tool_search",
        query="Ymcp",
        wing="personal",
        room="ymcp",
    )
    assert captured["wing"] == "personal"
    assert captured["room"] == "ymcp"
    assert result.artifacts.raw["filters"] == {"wing": "personal", "room": "ymcp"}


def test_call_mempalace_tool_emits_trace_logs_when_enabled(monkeypatch, caplog):
    from ymcp import memory

    class FakeModule:
        @staticmethod
        def tool_search(**kwargs):
            return {"results": [{"text": "ok"}]}

    monkeypatch.setenv("YMCP_TRACE_MEMORY", "1")
    monkeypatch.setattr(memory, "_mempalace_module", lambda palace_path=None: FakeModule)
    with caplog.at_level(logging.INFO, logger="ymcp.memory"):
        result = memory.call_mempalace_tool(
            "memory_search",
            "search",
            "tool_search",
            query="Ymcp 发布流程",
            wing="personal",
            room="ymcp",
            request_id="req123",
        )

    assert result.artifacts.count == 1
    messages = [record.getMessage() for record in caplog.records]
    assert any("event=memory_call_start" in message and "request_id=req123" in message for message in messages)
    assert any("event=memory_module_ready" in message and "request_id=req123" in message for message in messages)
    assert any("event=memory_function_resolved" in message and "request_id=req123" in message for message in messages)
    assert any("event=memory_call_end" in message and "request_id=req123" in message for message in messages)


def test_call_mempalace_tool_trace_logs_are_disabled_by_default(monkeypatch, caplog):
    from ymcp import memory

    class FakeModule:
        @staticmethod
        def tool_search(**kwargs):
            return {"results": []}

    monkeypatch.delenv("YMCP_TRACE_MEMORY", raising=False)
    monkeypatch.setattr(memory, "_mempalace_module", lambda palace_path=None: FakeModule)
    with caplog.at_level(logging.INFO, logger="ymcp.memory"):
        memory.call_mempalace_tool("memory_search", "search", "tool_search", query="Ymcp")

    assert caplog.records == []


def test_memory_status_handler_emits_trace_logs(monkeypatch, caplog):
    from ymcp import server
    from ymcp.memory import memory_result

    monkeypatch.setenv("YMCP_TRACE_MEMORY", "1")

    def fake_call(*args, **kwargs):
        return memory_result("memory_status", "status", {"total_drawers": 1})

    monkeypatch.setattr(server, "call_mempalace_tool", fake_call)
    monkeypatch.setattr(server, "mempalace_palace_path", lambda: r"C:\Users\BSTECH05\.yjj")

    async def _run():
        app = server.create_app()
        await app.call_tool("memory_status", {})

    with caplog.at_level(logging.INFO, logger="ymcp.memory"):
        anyio.run(_run)

    messages = [record.getMessage() for record in caplog.records]
    assert any("event=memory_status_handler_start" in message for message in messages)
    assert any("event=memory_status_handler_end" in message for message in messages)
    assert any("event=memory_status_handler_return" in message for message in messages)


def test_memory_search_handler_emits_return_trace_logs(monkeypatch, caplog):
    from ymcp import server
    from ymcp.memory import memory_result

    monkeypatch.setenv("YMCP_TRACE_MEMORY", "1")

    def fake_call(*args, **kwargs):
        return memory_result("memory_search", "search", {"query": "Ymcp", "results": []})

    monkeypatch.setattr(server, "call_mempalace_tool", fake_call)
    monkeypatch.setattr(server, "mempalace_palace_path", lambda: r"C:\Users\BSTECH05\.yjj")

    async def _run():
        app = server.create_app()
        await app.call_tool("memory_search", {"query": "Ymcp"})

    with caplog.at_level(logging.INFO, logger="ymcp.memory"):
        anyio.run(_run)

    messages = [record.getMessage() for record in caplog.records]
    assert any("event=memory_search_handler_start" in message for message in messages)
    assert any("event=memory_search_handler_end" in message for message in messages)
    assert any("event=memory_search_handler_return" in message for message in messages)

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

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

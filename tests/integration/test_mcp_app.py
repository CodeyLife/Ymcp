import anyio

from ymcp.server import create_app

EXPECTED_WORKFLOW_NAMES = {"plan", "ralplan", "deep_interview", "ralph"}
EXPECTED_MEMORY_NAMES = {
    "memory_store", "memory_search", "memory_get", "memory_update", "memory_delete",
    "memory_status", "memory_list_wings", "memory_list_rooms", "memory_taxonomy",
    "memory_check_duplicate", "memory_reconnect", "memory_graph_stats", "memory_graph_query",
    "memory_graph_traverse", "memory_kg_add", "memory_kg_timeline", "memory_kg_invalidate",
    "memory_create_tunnel", "memory_list_tunnels", "memory_find_tunnels", "memory_follow_tunnels",
    "memory_delete_tunnel", "memory_diary_write", "memory_diary_read",
}
EXPECTED_NAMES = EXPECTED_WORKFLOW_NAMES | EXPECTED_MEMORY_NAMES

FIXTURES = {
    "plan": {"task": "为 Ymcp 工作流提供状态机输出", "constraints": ["宿主控制执行"]},
    "ralplan": {"task": "规划 Ymcp 状态机 refactor", "current_phase": "planner_draft"},
    "deep_interview": {"brief": "希望工作流工具更适合 Trae 使用", "prior_rounds": []},
    "ralph": {"approved_plan": "Implement workflow state machine", "latest_evidence": ["planner draft ready"], "verification_commands": ["python -m pytest"]},
    "memory_status": {},
    "memory_search": {"query": "Ymcp 发布流程", "limit": 2},
}


async def _exercise_app():
    app = create_app()
    tools = await app.list_tools()
    assert {tool.name for tool in tools} == EXPECTED_NAMES
    for name, args in FIXTURES.items():
        result = await app.call_tool(name, args)
        if isinstance(result, tuple):
            _, structured = result
        else:
            structured = result
        assert isinstance(structured, dict)
        assert structured["status"] in {"ok", "needs_input", "blocked", "error"}
        assert structured["schema_version"] == "1.0"
        assert structured["summary"]
        assert structured["artifacts"]
        if name in EXPECTED_WORKFLOW_NAMES:
            assert structured["artifacts"]["workflow_state"]["workflow_name"] == name
            assert structured["artifacts"]["workflow_state"]["host_next_action"]
            if name in {"deep_interview", "plan", "ralplan"}:
                assert structured["artifacts"]["workflow_state"]["memory_preflight"] is not None
            assert structured["artifacts"]["continuation"]["interaction_mode"]
            assert structured["artifacts"]["continuation"]["recommended_host_action"]
            assert "handoff_options" in structured["artifacts"]["continuation"]


def test_fastmcp_tool_discovery_and_calls():
    anyio.run(_exercise_app)



def test_deep_interview_accepts_json_string_lists_from_host():
    async def _run():
        app = create_app()
        result = await app.call_tool(
            "deep_interview",
            {
                "brief": "希望工作流工具更适合 Trae 使用",
                "known_context": '["项目结构：Flutter 项目","稳定性优先"]',
                "non_goals": '["不做 agent runtime"]',
                "decision_boundaries": '["宿主负责执行"]',
                "prior_rounds": '[]',
            },
        )
        if isinstance(result, tuple):
            _, structured = result
        else:
            structured = result
        assert structured["artifacts"]["workflow_state"]["workflow_name"] == "deep_interview"
        assert structured["artifacts"]["interaction_mode"] in {"ask_user", "handoff"}
    anyio.run(_run)



def test_workflows_auto_read_memory_when_context_missing(monkeypatch):
    import ymcp.server as server

    def fake_memory(tool_name, operation, function_name, *args, **kwargs):
        from ymcp.memory import memory_result
        return memory_result(tool_name, operation, {"results": [{"summary": "用户偏好中文输出"}]})

    monkeypatch.setattr(server, "call_mempalace_tool", fake_memory)

    async def _run():
        app = create_app()
        for name, args in {
            "deep_interview": {"brief": "优化项目稳定性"},
            "plan": {"task": "优化项目稳定性", "mode": "direct"},
            "ralplan": {"task": "优化项目稳定性", "current_phase": "planner_draft"},
        }.items():
            result = await app.call_tool(name, args)
            structured = result[1] if isinstance(result, tuple) else result
            preflight = structured["artifacts"]["workflow_state"]["memory_preflight"]
            assert preflight["search_performed"] is True
            assert preflight["retrieved_count"] == 1
            assert "用户偏好中文输出" in preflight["retrieved_context"][0]

    anyio.run(_run)

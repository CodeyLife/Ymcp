import anyio

from ymcp.server import DeepInterviewNextToolInput, RalplanNextToolInput, create_app

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
EXPECTED_RESOURCE_URIS = {
    "resource://ymcp/principles",
    "resource://ymcp/tool-reference",
    "resource://ymcp/memory-protocol",
    "resource://ymcp/project-rule-template",
    "resource://ymcp/host-integration",
}
EXPECTED_PROMPT_NAMES = {
    "deep_interview_clarify",
    "plan_direct",
    "ralplan_consensus",
    "ralplan_planner_pass",
    "ralplan_architect_pass",
    "ralplan_critic_pass",
    "ralph_verify",
    "memory_store_after_completion",
}

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
    resources = await app.list_resources()
    assert {str(resource.uri) for resource in resources} == EXPECTED_RESOURCE_URIS
    prompts = await app.list_prompts()
    assert {prompt.name for prompt in prompts} == EXPECTED_PROMPT_NAMES
    principles = await app.read_resource("resource://ymcp/principles")
    assert "Tools" in principles[0].content
    assert "Resources" in principles[0].content
    assert "Prompts" in principles[0].content
    assert "Elicitation" in principles[0].content
    prompt = await app.get_prompt("plan_direct", {"task": "测试 FastMCP 三原语"})
    assert "plan" in prompt.messages[0].content.text
    assert "测试 FastMCP 三原语" in prompt.messages[0].content.text
    architect_prompt = await app.get_prompt("ralplan_architect_pass", {"task": "规划 Ymcp", "planner_draft": "draft"})
    assert "Architect" in architect_prompt.messages[0].content.text
    assert "planner_draft: draft" in architect_prompt.messages[0].content.text
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
            if name in {"deep_interview", "plan", "ralplan"}:
                assert structured["artifacts"]["workflow_state"]["memory_preflight"] is not None
            assert "interaction" not in structured["artifacts"]
            assert "continuation" not in structured["artifacts"]


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
        assert structured["artifacts"]["requested_input"]
    anyio.run(_run)


def test_deep_interview_crystallize_exposes_handoff_options():
    async def _run():
        app = create_app()
        result = await app.call_tool(
            "deep_interview",
            {
                "brief": "为 Ymcp 的工作流工具建立状态机投影",
                "known_context": ["当前已有 4 个 workflow tools"],
                "non_goals": ["不做 agent runtime"],
                "decision_boundaries": ["宿主负责循环和执行"],
                "profile": "quick",
                "prior_rounds": [
                    {"question": "Q1", "answer": "解决宿主难以继续推进的问题"},
                    {"question": "Q2", "answer": "第一版不直接执行命令"},
                    {"question": "Q3", "answer": "输出必须可交给 Trae"},
                    {"question": "Q4", "answer": "验收标准要可测试"},
                    {"question": "Q5", "answer": "保留现有工具名"},
                ],
            },
        )
        structured = result[1] if isinstance(result, tuple) else result
        assert structured["status"] == "needs_input"
        assert structured["artifacts"]["workflow_state"]["readiness"] == "needs_user_choice"
        assert {item["id"] for item in structured["artifacts"]["handoff_options"]} == {"ralplan", "plan", "ralph", "refine_further"}
        assert structured["artifacts"]["selected_next_tool"] is None
    anyio.run(_run)


def test_deep_interview_elicitation_schema_uses_standard_single_choice_shape():
    schema = DeepInterviewNextToolInput.model_json_schema()
    next_tool = schema["properties"]["next_tool"]
    assert next_tool["type"] == "string"
    assert next_tool["title"] == "下一步工作流"
    assert "oneOf" in next_tool
    assert {item["const"] for item in next_tool["oneOf"]} == {"ralplan", "plan", "ralph", "refine_further"}
    assert any(item["title"] == "ralplan（推荐）" for item in next_tool["oneOf"])


def test_ralplan_approved_exposes_handoff_options():
    async def _run():
        app = create_app()
        result = await app.call_tool(
            "ralplan",
            {
                "task": "规划 Ymcp workflow refactor",
                "current_phase": "critic_review",
            },
        )
        structured = result[1] if isinstance(result, tuple) else result
        assert structured["artifacts"]["workflow_state"]["current_phase"] == "approved"
        assert {item["id"] for item in structured["artifacts"]["handoff_options"]} == {"ralph", "plan", "memory_store"}
        assert structured["artifacts"]["selected_next_tool"] is None
    anyio.run(_run)


def test_ralplan_phase_outputs_prompt_refs():
    async def _run():
        app = create_app()
        planner_result = await app.call_tool(
            "ralplan",
            {
                "task": "规划 Ymcp workflow refactor",
                "current_phase": "planner_draft",
                "planner_draft": "draft-v1",
            },
        )
        planner_structured = planner_result[1] if isinstance(planner_result, tuple) else planner_result
        assert planner_structured["artifacts"]["planner_prompt_ref"]["name"] == "ralplan_planner_pass"
        assert planner_structured["artifacts"]["architect_prompt_ref"]["name"] == "ralplan_architect_pass"

        architect_result = await app.call_tool(
            "ralplan",
            {
                "task": "规划 Ymcp workflow refactor",
                "current_phase": "architect_review",
                "planner_draft": "draft-v1",
                "architect_feedback": ["需要边界条件"],
            },
        )
        architect_structured = architect_result[1] if isinstance(architect_result, tuple) else architect_result
        assert architect_structured["artifacts"]["critic_prompt_ref"]["name"] == "ralplan_critic_pass"
        assert architect_structured["artifacts"]["critic_prompt_ref"]["arguments"]["architect_feedback"] == ["需要边界条件"]

    anyio.run(_run)


def test_ralplan_prompt_refs_render_with_tool_returned_argument_shapes():
    async def _run():
        app = create_app()

        planner_result = await app.call_tool(
            "ralplan",
            {
                "task": "规划 Ymcp workflow refactor",
                "current_phase": "planner_draft",
            },
        )
        planner_structured = planner_result[1] if isinstance(planner_result, tuple) else planner_result
        planner_ref = planner_structured["artifacts"]["planner_prompt_ref"]
        planner_prompt = await app.get_prompt(planner_ref["name"], planner_ref["arguments"])
        assert "Planner" in planner_prompt.messages[0].content.text
        assert "constraints: []" in planner_prompt.messages[0].content.text

        architect_result = await app.call_tool(
            "ralplan",
            {
                "task": "规划 Ymcp workflow refactor",
                "current_phase": "architect_review",
                "planner_draft": "draft-v1",
                "architect_feedback": ["需要边界条件"],
            },
        )
        architect_structured = architect_result[1] if isinstance(architect_result, tuple) else architect_result
        critic_ref = architect_structured["artifacts"]["critic_prompt_ref"]
        critic_prompt = await app.get_prompt(critic_ref["name"], critic_ref["arguments"])
        assert "Critic" in critic_prompt.messages[0].content.text
        assert "- 需要边界条件" in critic_prompt.messages[0].content.text

    anyio.run(_run)


def test_ralplan_elicitation_schema_uses_standard_single_choice_shape():
    schema = RalplanNextToolInput.model_json_schema()
    next_tool = schema["properties"]["next_tool"]
    assert next_tool["type"] == "string"
    assert next_tool["title"] == "下一步工作流"
    assert "oneOf" in next_tool
    assert {item["const"] for item in next_tool["oneOf"]} == {"ralph", "plan", "memory_store"}



def test_workflows_require_explicit_memory_search_when_context_missing():
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
            assert preflight["required"] is True
            assert preflight["search_performed"] is False
            assert preflight["retrieved_count"] == 0
            assert preflight["retrieved_context"] == []

    anyio.run(_run)


def test_workflows_accept_structured_memory_context():
    async def _run():
        app = create_app()
        for name, args in {
            "deep_interview": {"brief": "优化项目稳定性", "memory_context": {"searched": True, "hits": ["记忆A"], "query": "稳定性"}},
            "plan": {"task": "优化项目稳定性", "mode": "direct", "memory_context": {"searched": True, "hits": ["记忆A"]}},
            "ralplan": {"task": "优化项目稳定性", "current_phase": "planner_draft", "memory_context": {"searched": True, "hits": ["记忆A"]}},
        }.items():
            result = await app.call_tool(name, args)
            structured = result[1] if isinstance(result, tuple) else result
            preflight = structured["artifacts"]["workflow_state"]["memory_preflight"]
            assert preflight["search_performed"] is True
            assert preflight["retrieved_count"] == 1
            assert preflight["retrieved_context"] == ["记忆A"]

    anyio.run(_run)


def test_memory_tool_runtime_schema_matches_supported_parameters():
    async def _run():
        app = create_app()
        tools = {tool.name: tool for tool in await app.list_tools()}
        assert "depth" not in tools["memory_follow_tunnels"].inputSchema["properties"]
        assert "date" not in tools["memory_diary_read"].inputSchema["properties"]
        assert "source" not in tools["memory_kg_invalidate"].inputSchema["properties"]

    anyio.run(_run)


def test_memory_result_limits_are_enforced(monkeypatch):
    import ymcp.server as server
    from ymcp.memory import memory_result

    def fake_memory(tool_name, operation, function_name, *args, **kwargs):
        if tool_name == "memory_graph_query":
            return memory_result(tool_name, operation, {"results": [{"id": 1}, {"id": 2}, {"id": 3}]})
        if tool_name == "memory_find_tunnels":
            return memory_result(tool_name, operation, {"results": [{"id": "a"}, {"id": "b"}, {"id": "c"}]})
        if tool_name == "memory_kg_timeline":
            return memory_result(tool_name, operation, {"results": [{"t": 1}, {"t": 2}, {"t": 3}]})
        return memory_result(tool_name, operation, {})

    monkeypatch.setattr(server, "call_mempalace_tool", fake_memory)

    async def _run():
        app = create_app()
        for name in ("memory_graph_query", "memory_find_tunnels", "memory_kg_timeline"):
            result = await app.call_tool(name, {"query": "ymcp", "limit": 2})
            structured = result[1] if isinstance(result, tuple) else result
            assert structured["artifacts"]["count"] == 2
            assert len(structured["artifacts"]["items"]) == 2

    anyio.run(_run)

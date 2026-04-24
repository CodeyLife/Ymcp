import anyio

from ymcp.contracts.memory import MEMPALACE_TOOL_SCHEMAS
from ymcp.memory import limit_memory_result_items
from ymcp.server import (
    DeepInterviewNextToolInput,
    PlanClarifyChoiceInput,
    PlanTaskDetailsInput,
    RalphEvidenceInput,
    RalphVerificationInput,
    RalplanNextToolInput,
    _split_lines,
    create_app,
)

EXPECTED_WORKFLOW_NAMES = {"plan", "ralplan", "ralplan_planner", "ralplan_architect", "ralplan_critic", "ralplan_handoff", "deep_interview", "ralph"}
EXPECTED_MEMORY_NAMES = {tool["name"] for tool in MEMPALACE_TOOL_SCHEMAS}
EXPECTED_NAMES = EXPECTED_WORKFLOW_NAMES | EXPECTED_MEMORY_NAMES
EXPECTED_RESOURCE_URIS = {"resource://ymcp/principles", "resource://ymcp/tool-reference", "resource://ymcp/memory-protocol", "resource://ymcp/project-rule-template", "resource://ymcp/host-integration"}
EXPECTED_PROMPT_NAMES = {"deep_interview_clarify", "plan_direct", "ralplan_consensus", "ralplan_planner_pass", "ralplan_architect_pass", "ralplan_critic_pass", "ralph_verify", "memory_store_after_completion"}

FIXTURES = {
    "plan": {"task": "为 Ymcp 工作流提供状态机输出", "constraints": ["宿主控制执行"]},
    "ralplan": {"task": "规划 Ymcp 状态机 refactor"},
    "ralplan_planner": {"task": "规划 Ymcp 状态机 refactor", "known_context": ["workflow server"]},
    "ralplan_architect": {"task": "规划 Ymcp 状态机 refactor", "planner_draft": "draft", "known_context": ["workflow server"]},
    "ralplan_critic": {"task": "规划 Ymcp 状态机 refactor", "planner_draft": "draft", "architect_review": "review", "known_context": ["workflow server"]},
    "ralplan_handoff": {"task": "规划 Ymcp 状态机 refactor", "critic_verdict": "APPROVE", "approved_plan_summary": "approved", "known_context": ["workflow server"]},
    "deep_interview": {"brief": "希望工作流工具更适合 Trae 使用", "prior_rounds": []},
    "ralph": {"approved_plan": "Implement workflow state machine", "latest_evidence": ["planner draft ready"], "verification_commands": ["python -m pytest"]},
    "mempalace_status": {},
    "mempalace_search": {"query": "Ymcp 发布流程", "limit": 2},
}


async def _exercise_app():
    app = create_app()
    tools = await app.list_tools()
    assert {tool.name for tool in tools} == EXPECTED_NAMES
    tool_map = {tool.name: tool for tool in tools}
    assert tool_map["ralplan_handoff"].outputSchema["title"] == "RalplanHandoffResult"
    for name, args in FIXTURES.items():
        result = await app.call_tool(name, args)
        structured = result[1] if isinstance(result, tuple) else result
        assert structured["summary"]
        assert structured["meta"]["required_host_action"]
        assert structured["artifacts"]["workflow_state"]["workflow_name"] == name if name in EXPECTED_WORKFLOW_NAMES else True


def test_fastmcp_tool_discovery_and_calls():
    anyio.run(_exercise_app)


def test_ralplan_handoff_requests_host_choice_without_elicitation_support():
    async def _run():
        app = create_app()
        result = await app.call_tool("ralplan_handoff", {"task": "分析 SignalR 推送链路", "critic_verdict": "APPROVE", "approved_plan_summary": "approved", "known_context": ["CaseUpdatedHub"]})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured["status"] == "needs_input"
        assert structured["meta"]["required_host_action"] == "await_input"
        assert structured["meta"]["requires_elicitation"] is True
        assert structured["meta"]["requires_explicit_user_choice"] is True
        assert "宿主应展示下一步 workflow 选项" in structured["next_actions"][0]["description"]
    anyio.run(_run)


def test_deep_interview_requests_host_elicitation_without_capability_support():
    async def _run():
        app = create_app()
        result = await app.call_tool("deep_interview", {"brief": "Build MCP workflows", "prior_rounds": []})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured["status"] == "needs_input"
        assert structured["meta"]["required_host_action"] == "await_input"
        assert structured["meta"]["requires_elicitation"] is True
        assert "宿主应通过 MCP Elicitation 展示下一问并收集用户回答" in structured["summary"]
    anyio.run(_run)


def test_plan_preserves_host_choice_request_without_capability_support():
    async def _run():
        app = create_app()
        result = await app.call_tool("plan", {"task": "为 Ymcp 增加状态机工作流输出", "constraints": ["宿主控制执行"]})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured["status"] == "ok"
        assert structured["meta"]["required_host_action"] == "await_input"
        assert structured["meta"]["requires_elicitation"] is True
        assert "宿主应提供下一步 workflow 选项" in structured["summary"]
    anyio.run(_run)


def test_ralph_preserves_host_input_request_without_capability_support():
    async def _run():
        app = create_app()
        result = await app.call_tool("ralph", {"approved_plan": "Do the plan"})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured["status"] == "needs_input"
        assert structured["meta"]["required_host_action"] == "await_input"
        assert structured["meta"]["requires_elicitation"] is True
        assert "宿主应通过 MCP Elicitation 收集 latest_evidence" in structured["summary"]
    anyio.run(_run)


def test_deep_interview_elicitation_schema_uses_standard_single_choice_shape():
    schema = DeepInterviewNextToolInput.model_json_schema()
    assert schema["properties"]["next_tool"]["type"] == "string"


def test_ralplan_handoff_elicitation_schema_uses_standard_single_choice_shape():
    schema = RalplanNextToolInput.model_json_schema()
    assert schema["properties"]["next_tool"]["type"] == "string"
    assert all("description" not in option for option in schema["properties"]["next_tool"]["oneOf"])


def test_plan_clarify_elicitation_schemas_use_flat_primitives():
    choice_schema = PlanClarifyChoiceInput.model_json_schema()
    details_schema = PlanTaskDetailsInput.model_json_schema()
    assert choice_schema["properties"]["next_action"]["type"] == "string"
    assert details_schema["properties"]["task_details"]["type"] == "string"


def test_ralph_elicitation_schemas_use_string_fields_not_freeform_arrays():
    evidence_schema = RalphEvidenceInput.model_json_schema()
    verification_schema = RalphVerificationInput.model_json_schema()
    assert evidence_schema["properties"]["latest_evidence_text"]["type"] == "string"
    assert verification_schema["properties"]["verification_commands_text"]["type"] == "string"


def test_split_lines_parses_multiline_elicitation_text():
    assert _split_lines(" first \n\nsecond\n  \nthird ") == ["first", "second", "third"]


def test_memory_tool_runtime_schema_matches_mempalace_parameters():
    async def _run():
        app = create_app()
        tools = {tool.name: tool for tool in await app.list_tools()}
        assert "room" in tools["mempalace_follow_tunnels"].inputSchema["properties"]
        assert "last_n" in tools["mempalace_diary_read"].inputSchema["properties"]
    anyio.run(_run)


def test_memory_result_limits_are_enforced(monkeypatch):
    import ymcp.server as server
    from ymcp.memory import memory_result

    def fake_memory(tool_name, **kwargs):
        limit = kwargs.get("limit")
        if tool_name == "mempalace_search":
            result = memory_result(tool_name, tool_name, {"results": [{"id": 1}, {"id": 2}, {"id": 3}]})
            return result if limit is None else limit_memory_result_items(result, limit)
        return memory_result(tool_name, tool_name, {})

    monkeypatch.setattr(server, "execute_memory_operation", fake_memory)

    async def _run():
        app = create_app()
        result = await app.call_tool("mempalace_search", {"query": "ymcp", "limit": 2})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured["artifacts"]["count"] == 2
    anyio.run(_run)

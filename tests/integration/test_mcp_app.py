import anyio

from ymcp.server import create_app

EXPECTED_NAMES = {"plan", "ralplan", "deep_interview", "ralph"}

FIXTURES = {
    "plan": {"problem": "Ship Ymcp v1", "constraints": ["host-controlled"]},
    "ralplan": {"task": "Plan Ymcp v1", "constraints": ["Exactly four tools"]},
    "deep_interview": {"brief": "Need an MCP workflow library", "prior_rounds": []},
    "ralph": {"approved_plan": "Implement the approved PRD", "evidence": ["contracts completed"]},
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
        assert structured["status"] in {"ok", "needs_input", "blocked"}
        assert structured["schema_version"] == "1.0"
        assert structured["summary"]
        assert structured["artifacts"]


def test_fastmcp_tool_discovery_and_calls():
    anyio.run(_exercise_app)

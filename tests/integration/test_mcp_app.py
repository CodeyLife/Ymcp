import anyio

from ymcp.contracts.memory import MEMPALACE_TOOL_SCHEMAS
from ymcp.server import create_app

EXPECTED_WORKFLOW_NAMES = {'ydeep', 'ydeep_complete', 'yplan', 'yplan_architect', 'yplan_critic', 'yplan_complete', 'ydo', 'ydo_complete'}
EXPECTED_MEMORY_NAMES = {tool['name'] for tool in MEMPALACE_TOOL_SCHEMAS}
EXPECTED_NAMES = EXPECTED_WORKFLOW_NAMES | EXPECTED_MEMORY_NAMES
EXPECTED_RESOURCE_URIS = {'resource://ymcp/principles', 'resource://ymcp/memory-protocol', 'resource://ymcp/project-rule-template'}
EXPECTED_PROMPT_NAMES = {'architect', 'critic', 'deep-interview', 'plan', 'planner', 'ralph', 'ralplan'}

FIXTURES = {
    'ydeep': {'brief': '明确当前需求'},
    'ydeep_complete': {'brief': '明确当前需求', 'summary': '已完成需求调研总结'},
    'yplan': {'task': '恢复三工具架构'},
    'yplan_architect': {'task': '恢复三工具架构', 'plan_summary': '保留三工具外壳', 'planner_notes': ['planner ok']},
    'yplan_critic': {'task': '恢复三工具架构', 'plan_summary': '保留三工具外壳', 'planner_notes': ['planner ok'], 'architect_notes': ['architect ok'], 'critic_verdict': 'APPROVE', 'critic_notes': ['方案通过评审'], 'acceptance_criteria': ['可进入 ydo']},
    'yplan_complete': {'task': '恢复三工具架构', 'summary': '已完成方案总结', 'critic_verdict': 'APPROVE', 'plan_summary': '保留三工具外壳', 'planner_notes': ['planner ok'], 'architect_notes': ['architect ok'], 'critic_notes': ['critic ok'], 'acceptance_criteria': ['可进入 ydo']},
    'ydo': {'approved_plan': '按批准方案执行'},
    'ydo_complete': {'approved_plan': '按批准方案执行', 'summary': '已完成执行总结'},
    'mempalace_status': {},
}


async def _exercise_app():
    app = create_app()
    tools = await app.list_tools()
    assert {tool.name for tool in tools} == EXPECTED_NAMES
    for name, args in FIXTURES.items():
        result = await app.call_tool(name, args)
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['summary']


def test_fastmcp_tool_discovery_and_calls():
    anyio.run(_exercise_app)


def test_ydeep_start_returns_completion_tool():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydeep', {'brief': '收敛需求'})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['artifacts']['readiness_verdict'] == 'prompt_required'
        assert structured['artifacts']['completion_tool'] == 'ydeep_complete'
        assert 'Task / Arguments:' in structured['artifacts']['skill_content']
    anyio.run(_run)


def test_ydeep_complete_ready_exposes_handoff_options():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydeep_complete', {'brief': '收敛需求', 'summary': '已完成需求调研总结'})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['artifacts']['readiness_verdict'] == 'ready'
        assert structured['meta']['requires_explicit_user_choice'] is True
    anyio.run(_run)


def test_yplan_start_returns_architect_next_tool():
    async def _run():
        app = create_app()
        result = await app.call_tool('yplan', {'task': '恢复三工具'})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['artifacts']['suggested_prompt'] == 'planner'
        assert structured['artifacts']['next_tool'] == 'yplan_architect'
        assert 'Task / Arguments:' in structured['artifacts']['skill_content']
    anyio.run(_run)


def test_yplan_complete_exposes_ydo_restart_and_memory_options():
    async def _run():
        app = create_app()
        result = await app.call_tool('yplan_complete', {'task': '恢复三工具', 'summary': '已完成方案总结', 'critic_verdict': 'APPROVE', 'plan_summary': '方案已收敛'})
        structured = result[1] if isinstance(result, tuple) else result
        options = {item['value'] for item in structured['artifacts']['handoff_options']}
        assert {'ydo', 'restart', 'memory_store'} <= options
        assert structured['meta']['requires_explicit_user_choice'] is True
    anyio.run(_run)


def test_yplan_complete_blocks_revise_verdict():
    async def _run():
        app = create_app()
        result = await app.call_tool('yplan_complete', {'task': '恢复三工具', 'summary': '仍需修订', 'critic_verdict': 'REVISE', 'plan_summary': '方案未收敛'})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['status'] == 'blocked'
        assert structured['artifacts']['consensus_verdict'] == 'needs_revision'
    anyio.run(_run)


def test_ydo_start_returns_completion_tool():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydo', {'approved_plan': '执行'})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['artifacts']['completion_tool'] == 'ydo_complete'
        assert structured['artifacts']['readiness_verdict'] == 'prompt_required'
        assert 'Task / Arguments:' in structured['artifacts']['skill_content']
    anyio.run(_run)


def test_ydo_complete_exposes_finish_option():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydo_complete', {'approved_plan': '执行', 'summary': '已完成执行总结'})
        structured = result[1] if isinstance(result, tuple) else result
        options = {item['value'] for item in structured['artifacts']['handoff_options']}
        assert 'finish' in options
        assert structured['artifacts']['execution_verdict'] == 'complete'
    anyio.run(_run)

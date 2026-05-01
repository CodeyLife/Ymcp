import anyio

from ymcp.contracts.memory import MEMPALACE_TOOL_SCHEMAS
from ymcp.server import create_app

EXPECTED_WORKFLOW_NAMES = {'ydeep', 'yplan', 'ydo', 'menu', 'yimggen'}
EXPECTED_MEMORY_NAMES = {tool['name'] for tool in MEMPALACE_TOOL_SCHEMAS}
EXPECTED_NAMES = EXPECTED_WORKFLOW_NAMES | EXPECTED_MEMORY_NAMES
EXPECTED_RESOURCE_URIS = {'resource://ymcp/principles', 'resource://ymcp/memory-protocol', 'resource://ymcp/workflow-contracts', 'resource://ymcp/project-rule-template'}


def _assert_webui_fallback(structured, expected_values):
    assert structured['summary'].startswith('WORKFLOW_PAUSED_AWAITING_SELECTED_OPTION')
    assert 'WebUI fallback' in structured['summary']
    assert structured['meta']['menu_authority'] == 'meta.handoff.options'
    assert structured['meta']['elicitation_error']
    assert structured['meta']['host_controls'] == ['display', 'webui fallback', 'selected_option tool recall']
    assert structured['meta']['ui_request']['kind'] == 'await_selected_option'
    assert structured['meta']['ui_request']['selected_option_param'] == 'selected_option'
    assert structured['meta']['ui_request']['webui_url'].startswith('http://127.0.0.1:')
    assert structured['meta']['ui_request']['menu_session_id']
    assert [item['value'] for item in structured['meta']['handoff']['options']] == list(expected_values)
    assert [item['value'] for item in structured['meta']['ui_request']['options']] == list(expected_values)
    assert structured['next_actions'] == []


async def _exercise_app():
    app = create_app()
    tools = await app.list_tools()
    assert {tool.name for tool in tools} == EXPECTED_NAMES
    start = await app.call_tool('ydeep', {'brief': '明确当前需求'})
    structured = start[1] if isinstance(start, tuple) else start
    assert structured['summary']


def test_fastmcp_tool_discovery_and_calls():
    anyio.run(_exercise_app)


def test_fastmcp_resource_discovery():
    async def _run():
        app = create_app()
        resources = await app.list_resources()
        assert {str(resource.uri) for resource in resources} == EXPECTED_RESOURCE_URIS
    anyio.run(_run)


def test_ydeep_start_returns_menu_handoff():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydeep', {'brief': '收敛需求'})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['meta']['handoff']['recommended_next_action'] == 'menu'
        assert 'Task / Arguments:' in structured['artifacts']['skill_content']
    anyio.run(_run)


def test_yplan_start_returns_menu_handoff():
    async def _run():
        app = create_app()
        result = await app.call_tool('yplan', {'task': '恢复三工具'})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['artifacts']['suggested_prompt'] == 'plan'
        assert structured['meta']['handoff']['recommended_next_action'] == 'menu'
        assert 'planner / architect / critic' in structured['summary']
    anyio.run(_run)


def test_ydo_start_returns_menu_handoff():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydo', {})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['meta']['handoff']['recommended_next_action'] == 'menu'
        assert '不再要求 `approved_plan_artifact` 输入' in structured['summary']
        assert 'Task / Arguments:' in structured['artifacts']['skill_content']
    anyio.run(_run)


def test_menu_without_elicitation_starts_webui_fallback(monkeypatch):
    opened = []
    monkeypatch.setenv('YMCP_MENU_WAIT_FOR_SELECTION', '0')
    monkeypatch.setattr('ymcp.web.menu_app.webbrowser.open', lambda url, new=0: opened.append((url, new)) or True)

    async def _run():
        app = create_app()
        result = await app.call_tool('menu', {
            'source_workflow': 'yplan',
            'summary': 'critic 已批准，验收和验证路径明确',
            'options': [
                {'value': 'ydo', 'title': '进入 ydo', 'description': '执行', 'recommended': True},
                {'value': 'memory_store', 'title': '保存记忆', 'description': '沉淀经验'},
            ],
        })
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['status'] == 'blocked'
        assert structured['meta']['required_host_action'] == 'await_input'
        assert structured['meta']['elicitation_required'] is True
        assert structured['meta']['elicitation_state'] == 'unsupported'
        assert structured['artifacts']['workflow_state']['current_phase'] == 'awaiting_user_selection'
        assert structured['artifacts']['workflow_state']['current_focus'] == 'fallback_requires_interactive_menu'
        assert structured['artifacts']['webui_url'].startswith('http://127.0.0.1:')
        assert opened == [(structured['artifacts']['webui_url'], 2)]
        _assert_webui_fallback(structured, ('ydo', 'memory_store'))
    anyio.run(_run)


def test_menu_invalid_selected_option_starts_webui_fallback(monkeypatch):
    opened = []
    monkeypatch.setenv('YMCP_MENU_WAIT_FOR_SELECTION', '0')
    monkeypatch.setattr('ymcp.web.menu_app.webbrowser.open', lambda url, new=0: opened.append((url, new)) or True)

    async def _run():
        app = create_app()
        result = await app.call_tool('menu', {
            'source_workflow': 'yplan',
            'summary': 'critic 已批准，验收和验证路径明确',
            'options': [
                {'value': 'ydo', 'title': '进入 ydo', 'description': '执行', 'recommended': True},
                {'value': 'memory_store', 'title': '保存记忆', 'description': '沉淀经验'},
            ],
            'selected_option': '',
        })
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['status'] == 'blocked'
        assert structured['meta']['elicitation_state'] == 'failed'
        assert structured['meta']['elicitation_error'] == '非法 selected_option：'
        assert structured['artifacts']['workflow_state']['current_phase'] == 'awaiting_user_selection'
        assert structured['artifacts']['workflow_state']['current_focus'] == 'fallback_requires_interactive_menu'
        assert structured['artifacts']['webui_url'].startswith('http://127.0.0.1:')
        assert opened == [(structured['artifacts']['webui_url'], 2)]
        _assert_webui_fallback(structured, ('ydo', 'memory_store'))
    anyio.run(_run)


def test_menu_accepts_selected_option_without_elicitation():
    async def _run():
        app = create_app()
        result = await app.call_tool('menu', {
            'source_workflow': 'ydo',
            'summary': '执行完成',
            'options': [{'value': 'finish', 'title': '结束', 'description': '结束', 'recommended': True}],
            'selected_option': 'finish',
        })
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['status'] == 'ok'
        assert structured['meta']['required_host_action'] == 'display_only'
        assert structured['meta']['elicitation_required'] is False
        assert structured['meta']['elicitation_selected_option'] == 'finish'
        assert structured['artifacts']['selected_option'] == 'finish'
        assert structured['artifacts']['workflow_state']['current_phase'] == 'selection_confirmed'
    anyio.run(_run)


def test_yimggen_returns_local_imagegen_guidance():
    async def _run():
        app = create_app()
        result = await app.call_tool('yimggen', {'brief': '生成 8 帧小球动画', 'asset_slug': 'ball', 'dimensions': '64x64', 'frame_count': 8})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['status'] == 'needs_input'
        assert structured['meta']['tool_name'] == 'yimggen'
        assert structured['artifacts']['suggested_prompt'] == 'imagegen'
        assert 'Task / Arguments:' in structured['artifacts']['skill_content']
    anyio.run(_run)

import anyio

from ymcp.contracts.memory import MEMPALACE_TOOL_SCHEMAS
from ymcp.server import create_app

EXPECTED_WORKFLOW_NAMES = {'ydeep', 'ydeep_menu', 'yplan', 'yplan_architect', 'yplan_critic', 'yplan_menu', 'ydo', 'ydo_menu', 'yimggen'}
EXPECTED_MEMORY_NAMES = {tool['name'] for tool in MEMPALACE_TOOL_SCHEMAS}
EXPECTED_NAMES = EXPECTED_WORKFLOW_NAMES | EXPECTED_MEMORY_NAMES
EXPECTED_RESOURCE_URIS = {'resource://ymcp/principles', 'resource://ymcp/memory-protocol', 'resource://ymcp/workflow-contracts', 'resource://ymcp/project-rule-template'}


def _assert_host_ui_fallback(structured, expected_values):
    assert structured['summary'].startswith('WORKFLOW_PAUSED_AWAITING_SELECTED_OPTION')
    assert 'meta.handoff.options' in structured['summary']
    assert 'selected_option' in structured['summary']
    assert structured['meta']['assistant_response_policy'] == 'stop_after_tool_result'
    assert structured['meta']['assistant_visible_response_allowed'] is False
    assert structured['meta']['host_ui_required'] is False
    assert structured['meta']['text_menu_forbidden'] is True
    assert structured['meta']['host_controls'] == []
    assert structured['meta']['menu_authority'] == 'meta.handoff.options'
    assert structured['meta']['ui_request']['kind'] == 'await_selected_option'
    assert structured['meta']['ui_request']['selected_option_param'] == 'selected_option'
    assert structured['meta']['ui_request']['failure_semantics'] == 'not_a_tool_failure'
    assert structured['meta']['ui_request']['assistant_instruction'] == 'STOP'
    assert set(structured['meta']['ui_request']) == {
        'kind',
        'selected_option_param',
        'failure_semantics',
        'assistant_instruction',
    }
    assert [item['value'] for item in structured['meta']['handoff']['options']] == list(expected_values)
    assert structured['meta']['handoff']['recommended_next_action'] in expected_values
    assert structured['next_actions'] == []


async def _exercise_app():
    app = create_app()
    tools = await app.list_tools()
    assert {tool.name for tool in tools} == EXPECTED_NAMES
    start = await app.call_tool('ydeep', {'brief': '明确当前需求'})
    structured = start[1] if isinstance(start, tuple) else start
    complete = await app.call_tool('ydeep_menu', {'summary': '已完成需求调研总结', 'brief': '明确当前需求'})
    structured_complete = complete[1] if isinstance(complete, tuple) else complete
    assert structured['summary']
    assert structured_complete['summary']


def test_fastmcp_tool_discovery_and_calls():
    anyio.run(_exercise_app)


def test_fastmcp_resource_discovery():
    async def _run():
        app = create_app()
        resources = await app.list_resources()
        assert {str(resource.uri) for resource in resources} == EXPECTED_RESOURCE_URIS
    anyio.run(_run)


def test_ydeep_start_returns_handoff():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydeep', {'brief': '收敛需求'})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['meta']['handoff']['recommended_next_action'] == 'ydeep_menu'
        assert 'Task / Arguments:' in structured['artifacts']['skill_content']
    anyio.run(_run)


def test_ydeep_menu_ready_exposes_handoff_options():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydeep_menu', {'summary': '已完成需求调研总结', 'brief': '收敛需求'})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['status'] == 'blocked'
        assert structured['meta']['required_host_action'] == 'await_input'
        assert structured['meta']['elicitation_required'] is True
        assert structured['meta']['elicitation_state'] == 'unsupported'
        assert structured['artifacts']['clarified_artifact']['summary'] == '已完成需求调研总结'
        assert structured['artifacts']['workflow_state']['current_phase'] == 'awaiting_user_selection'
        assert structured['artifacts']['workflow_state']['readiness'] == 'awaiting_user_selection'
        assert structured['artifacts']['workflow_state']['current_focus'] == 'fallback_requires_interactive_menu'
        _assert_host_ui_fallback(structured, ('yplan', 'refine_further'))
        assert structured['artifacts']['handoff_options'] == []
    anyio.run(_run)


def test_ydeep_menu_accepts_selected_option_without_elicitation():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydeep_menu', {'summary': '已完成需求调研总结', 'selected_option': 'refine_further'})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['status'] == 'ok'
        assert structured['meta']['required_host_action'] == 'display_only'
        assert structured['meta']['elicitation_required'] is False
        assert structured['meta']['elicitation_selected_option'] == 'refine_further'
        assert structured['artifacts']['selected_option'] == 'refine_further'
        assert structured['artifacts']['workflow_state']['current_phase'] == 'selection_confirmed'
    anyio.run(_run)


def test_yplan_chain_returns_handoffs_and_complete_artifact():
    async def _run():
        app = create_app()
        start = await app.call_tool('yplan', {'task': '恢复三工具'})
        start_structured = start[1] if isinstance(start, tuple) else start
        assert start_structured['artifacts']['suggested_prompt'] == 'planner'
        assert start_structured['meta']['handoff']['recommended_next_action'] == 'yplan_architect'

        architect = await app.call_tool('yplan_architect', {})
        architect_structured = architect[1] if isinstance(architect, tuple) else architect
        assert architect_structured['meta']['handoff']['recommended_next_action'] == 'yplan_critic'

        critic = await app.call_tool('yplan_critic', {})
        critic_structured = critic[1] if isinstance(critic, tuple) else critic
        assert critic_structured['status'] == 'blocked'
        assert critic_structured['artifacts']['workflow_state']['current_phase'] == 'architect_summary_required'
        assert '不能空参进入' in critic_structured['summary']

        critic = await app.call_tool('yplan_critic', {'architect_summary': '架构评估已完成，边界、tradeoff、风险明确'})
        critic_structured = critic[1] if isinstance(critic, tuple) else critic
        assert critic_structured['meta']['handoff']['recommended_next_action'] is None
        assert {item['value'] for item in critic_structured['meta']['handoff']['options']} == {'yplan', 'yplan_menu'}
        assert '必须选择 `yplan` 重开规划' in critic_structured['summary']
        assert 'critic_summary' in critic_structured['summary']
        assert '不要空参调用 `yplan_menu`' in critic_structured['summary']

        empty_complete = await app.call_tool('yplan_menu', {})
        empty_structured = empty_complete[1] if isinstance(empty_complete, tuple) else empty_complete
        assert empty_structured['status'] == 'blocked'
        assert empty_structured['artifacts']['workflow_state']['current_phase'] == 'critic_summary_required'
        assert '不能空参收口' in empty_structured['summary']

        complete = await app.call_tool('yplan_menu', {'critic_summary': 'critic 已批准，验收和验证路径明确'})
        structured = complete[1] if isinstance(complete, tuple) else complete
        assert structured['artifacts']['handoff_options'] == []
        assert structured['status'] == 'blocked'
        assert structured['meta']['required_host_action'] == 'await_input'
        assert structured['meta']['elicitation_required'] is True
        assert structured['meta']['elicitation_state'] == 'unsupported'
        assert structured['artifacts']['workflow_state']['current_phase'] == 'awaiting_user_selection'
        assert structured['artifacts']['workflow_state']['readiness'] == 'awaiting_user_selection'
        assert structured['artifacts']['workflow_state']['current_focus'] == 'fallback_requires_interactive_menu'
        _assert_host_ui_fallback(structured, ('ydo', 'restart', 'memory_store'))
    anyio.run(_run)


def test_yplan_menu_accepts_selected_option_without_elicitation():
    async def _run():
        app = create_app()
        result = await app.call_tool('yplan_menu', {'critic_summary': 'critic 已批准', 'selected_option': 'memory_store'})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['status'] == 'ok'
        assert structured['meta']['required_host_action'] == 'display_only'
        assert structured['meta']['elicitation_required'] is False
        assert structured['meta']['elicitation_selected_option'] == 'memory_store'
        assert structured['artifacts']['selected_option'] == 'memory_store'
        assert structured['artifacts']['workflow_state']['current_phase'] == 'selection_confirmed'
    anyio.run(_run)


def test_ydo_start_returns_handoff():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydo', {})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['meta']['handoff']['recommended_next_action'] == 'ydo_menu'
        assert '不再要求 `approved_plan_artifact` 输入' in structured['summary']
        assert 'Task / Arguments:' in structured['artifacts']['skill_content']
    anyio.run(_run)


def test_ydo_menu_exposes_finish_option():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydo_menu', {})
        structured = result[1] if isinstance(result, tuple) else result
        assert structured['artifacts']['handoff_options'] == []
        assert structured['artifacts']['execution_verdict'] == 'complete'
        assert structured['status'] == 'blocked'
        assert structured['meta']['required_host_action'] == 'await_input'
        assert structured['meta']['elicitation_required'] is True
        assert structured['meta']['elicitation_state'] == 'unsupported'
        assert structured['artifacts']['workflow_state']['current_phase'] == 'awaiting_user_selection'
        assert structured['artifacts']['workflow_state']['readiness'] == 'awaiting_user_selection'
        assert structured['artifacts']['workflow_state']['current_focus'] == 'fallback_requires_interactive_menu'
        _assert_host_ui_fallback(structured, ('finish', 'memory_store', 'yplan', 'continue_execution'))
    anyio.run(_run)


def test_ydo_menu_accepts_selected_option_without_elicitation():
    async def _run():
        app = create_app()
        result = await app.call_tool('ydo_menu', {'selected_option': 'finish'})
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
        assert structured['artifacts']['suggested_output_root'] == 'output/imagegen/ball'
        assert structured['artifacts']['frames_dir'] == 'output/imagegen/ball/frames'
        assert 'Task / Arguments:' in structured['artifacts']['skill_content']
        assert 'Frame count: 8' in structured['artifacts']['skill_content']
        assert 'remove_chroma_key' in structured['artifacts']['skill_content']
        assert structured['artifacts']['expected_artifacts'] == ['output/imagegen/ball/sprite.png', 'output/imagegen/ball/preview.gif']
        assert 'output/imagegen/ball/transparent_frames' in structured['artifacts']['transient_artifacts']
        assert structured['artifacts']['cleanup_steps']
        assert any('disposal=2' in step for step in structured['artifacts']['validation_steps'] + structured['artifacts']['postprocess_steps'])
        assert structured['artifacts']['completion_criteria']
        assert structured['artifacts']['validation_steps']
    anyio.run(_run)


def test_yimggen_transparent_guidance_includes_chroma_key_steps():
    async def _run():
        app = create_app()
        result = await app.call_tool('yimggen', {'brief': '生成透明小图标', 'asset_slug': 'icon', 'transparent': True})
        structured = result[1] if isinstance(result, tuple) else result
        skill_content = structured['artifacts']['skill_content']
        assert structured['status'] == 'needs_input'
        assert structured['artifacts']['expected_artifacts'] == ['output/imagegen/icon/sprite.png', 'output/imagegen/icon/preview.gif']
        assert 'output/imagegen/icon/transparent_frames' in structured['artifacts']['transient_artifacts']
        assert structured['artifacts']['postprocess_steps']
        assert 'remove_chroma_key' in skill_content
        assert '#00ff00' in skill_content
        assert 'transparent_frames/' in skill_content
        assert 'disposal=2' in structured['summary']
        assert any('auto_key="border"' in step for step in structured['artifacts']['postprocess_steps'])
    anyio.run(_run)


def test_yimggen_opaque_guidance_omits_chroma_key_requirements():
    async def _run():
        app = create_app()
        result = await app.call_tool('yimggen', {'brief': '生成白底图标', 'asset_slug': 'opaque-icon', 'transparent': False})
        structured = result[1] if isinstance(result, tuple) else result
        skill_content = structured['artifacts']['skill_content']
        assert structured['status'] == 'needs_input'
        assert 'Transparent output: false' in skill_content
        assert 'Transparent / background removal workflow:' not in skill_content
        assert 'output/imagegen/opaque-icon/transparent_frames' not in structured['artifacts']['transient_artifacts']
        assert structured['artifacts']['expected_artifacts'] == ['output/imagegen/opaque-icon/sprite.png', 'output/imagegen/opaque-icon/preview.gif']
        assert structured['artifacts']['postprocess_steps'] == []
    anyio.run(_run)

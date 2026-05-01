import ast
from pathlib import Path

from ymcp.contracts.common import HostActionType, HandoffOption, ToolStatus
from ymcp.contracts.deep_interview import DeepInterviewRequest
from ymcp.contracts.menu import MenuRequest
from ymcp.contracts.ralph import RalphRequest
from ymcp.contracts.ralplan import RalplanRequest
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.menu import build_menu
from ymcp.engine.ralph import build_ralph
from ymcp.engine.ralplan import build_ralplan


def _option(value, recommended=False):
    return HandoffOption(value=value, title=value, description=f'{value} option', recommended=recommended)


def test_deep_interview_start_returns_prompt_guidance_and_menu_handoff():
    result = build_deep_interview(DeepInterviewRequest(brief='收敛需求'))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.meta.handoff.recommended_next_action == 'menu'
    assert result.meta.handoff.options[0].value == 'menu'
    assert 'Task / Arguments:' in result.artifacts.skill_content
    assert '统一 `menu` tool' in result.summary


def test_ralplan_start_returns_plan_prompt_and_phase_gate():
    result = build_ralplan(RalplanRequest(task='恢复架构'))
    assert result.artifacts.suggested_prompt == 'plan'
    assert result.meta.handoff is None
    assert 'Task / Arguments:' in result.artifacts.skill_content
    assert 'name: plan' in result.artifacts.skill_content
    assert 'planner / architect / critic' in result.summary
    assert result.artifacts.workflow_state.readiness == 'needs_planner_summary'
    assert result.meta.ui_request['workflow_complete'] is False
    assert result.meta.ui_request['required_next_phase'] == 'planner'


def test_ralplan_architect_blocks_without_planner_summary():
    result = build_ralplan(RalplanRequest(task='恢复架构', phase='architect'))
    assert result.status is ToolStatus.BLOCKED
    assert result.meta.handoff is None
    assert result.artifacts.workflow_state.blocked_reason == 'planner_summary'
    assert result.meta.ui_request['must_continue'] is True
    assert result.meta.ui_request['missing_field'] == 'planner_summary'
    assert 'WORKFLOW_NOT_COMPLETE' in result.summary
    assert 'planner_summary' in result.summary


def test_ralplan_critic_blocks_without_architect_summary():
    result = build_ralplan(
        RalplanRequest(
            task='恢复架构',
            phase='critic',
            planner_summary='计划摘要',
            critic_verdict='APPROVE',
            critic_summary='critic 已批准',
        )
    )
    assert result.status is ToolStatus.BLOCKED
    assert result.meta.handoff is None
    assert result.artifacts.workflow_state.blocked_reason == 'architect_summary'
    assert result.meta.ui_request['missing_field'] == 'architect_summary'
    assert 'architect_summary' in result.summary


def test_ralplan_critic_approve_requires_menu_with_execution_options():
    result = build_ralplan(
        RalplanRequest(
            task='恢复架构',
            phase='critic',
            planner_summary='计划摘要',
            architect_summary='架构审查',
            critic_verdict='APPROVE',
            critic_summary='critic 已批准',
        )
    )
    assert result.status is ToolStatus.OK
    assert result.meta.handoff.recommended_next_action == 'menu'
    assert result.artifacts.workflow_state.readiness == 'ready_for_menu'
    assert 'ydo、yplan、memory_store' in result.next_actions[0].description


def test_ralplan_critic_iterate_requires_replan_without_menu_handoff():
    result = build_ralplan(
        RalplanRequest(
            task='恢复架构',
            phase='critic',
            planner_summary='计划摘要',
            architect_summary='架构审查',
            critic_verdict='ITERATE',
            critic_summary='还需修订',
        )
    )
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.meta.handoff is None
    assert result.artifacts.workflow_state.readiness == 'replan_required'
    assert result.meta.ui_request['workflow_complete'] is False
    assert result.meta.ui_request['required_next_phase'] == 'planner'
    assert result.meta.ui_request['replan_reason'] == 'ITERATE'
    assert 'WORKFLOW_NOT_COMPLETE' in result.summary
    assert 'menu' not in result.next_actions[0].description.lower()
    assert 'ydo' not in result.next_actions[0].description


def test_ralplan_critic_reject_requires_replan_without_menu_handoff():
    result = build_ralplan(
        RalplanRequest(
            task='恢复架构',
            phase='critic',
            planner_summary='计划摘要',
            architect_summary='架构审查',
            critic_verdict='REJECT',
            critic_summary='方案方向错误',
        )
    )
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.meta.handoff is None
    assert result.artifacts.workflow_state.readiness == 'replan_required'
    assert result.meta.ui_request['required_next_phase'] == 'planner'
    assert result.meta.ui_request['replan_reason'] == 'REJECT'
    assert 'ydo' not in result.next_actions[0].description


def test_ralph_start_returns_prompt_guidance_and_menu_handoff():
    result = build_ralph(RalphRequest())
    assert result.artifacts.suggested_prompt == 'ralph'
    assert result.meta.handoff.recommended_next_action == 'menu'
    assert result.meta.handoff.options[0].value == 'menu'
    assert '当前调用链上下文' in result.summary


def test_menu_exposes_dynamic_handoff_options():
    result = build_menu(MenuRequest(source_workflow='yplan', summary='规划完成', options=[_option('ydo', True), _option('memory_store')]))
    assert result.status is ToolStatus.OK
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert result.meta.handoff.recommended_next_action == 'ydo'
    assert [item.value for item in result.artifacts.handoff_options] == ['ydo', 'memory_store']
    assert result.artifacts.source_workflow == 'yplan'
    assert result.artifacts.received_summary == '规划完成'
    assert result.artifacts.workflow_state.current_phase == 'ready_for_handoff'


def test_menu_records_valid_selected_option():
    result = build_menu(MenuRequest(source_workflow='ydo', summary='执行完成', options=[_option('finish', True), _option('yplan')], selected_option='finish'))
    assert result.status is ToolStatus.OK
    assert result.meta.required_host_action is HostActionType.DISPLAY_ONLY
    assert result.meta.elicitation_selected_option == 'finish'
    assert result.artifacts.selected_option == 'finish'
    assert result.artifacts.workflow_state.current_phase == 'selection_confirmed'


def test_menu_records_free_user_input():
    result = build_menu(MenuRequest(source_workflow='ydo', summary='执行完成', options=[_option('finish', True)], user_input=' 请调整方向 '))
    assert result.status is ToolStatus.OK
    assert result.meta.required_host_action is HostActionType.DISPLAY_ONLY
    assert result.meta.elicitation_selected_option is None
    assert result.artifacts.selected_option is None
    assert result.artifacts.user_input == '请调整方向'
    assert result.artifacts.workflow_state.current_phase == 'input_confirmed'
    assert '已记录用户输入' in result.summary


def test_menu_blocks_blank_user_input():
    result = build_menu(MenuRequest(source_workflow='ydo', summary='执行完成', options=[_option('finish', True)], user_input='   '))
    assert result.status is ToolStatus.BLOCKED
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert result.meta.elicitation_error == 'user_input 不能为空'
    assert result.artifacts.user_input is None
    assert result.artifacts.workflow_state.current_focus == 'invalid_user_input'


def test_menu_blocks_invalid_selected_option():
    result = build_menu(MenuRequest(source_workflow='ydo', summary='执行完成', options=[_option('finish', True)], selected_option='invalid'))
    assert result.status is ToolStatus.BLOCKED
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert result.artifacts.selected_option is None
    assert result.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
    assert '非法 selected_option' in result.summary


def test_engines_do_not_use_subprocess_or_file_mutation_calls():
    engine_dir = Path('src/ymcp/engine')
    forbidden_names = {'subprocess', 'Popen', 'system', 'remove', 'unlink', 'rmdir', 'write_text', 'open'}
    for path in engine_dir.glob('*.py'):
        tree = ast.parse(path.read_text(encoding='utf-8'))
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                assert node.id not in forbidden_names
            if isinstance(node, ast.Attribute):
                assert node.attr not in forbidden_names

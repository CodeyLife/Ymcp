import ast
from pathlib import Path

from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.deep_interview import DeepInterviewCompleteRequest, DeepInterviewRequest
from ymcp.contracts.ralph import RalphCompleteRequest, RalphRequest
from ymcp.contracts.ralplan import RalplanArchitectRequest, RalplanCompleteRequest, RalplanCriticRequest, RalplanRequest
from ymcp.engine.deep_interview import build_deep_interview, build_deep_interview_complete
from ymcp.engine.ralph import build_ralph, build_ralph_complete
from ymcp.engine.ralplan import build_ralplan, build_ralplan_architect, build_ralplan_complete, build_ralplan_critic


def test_deep_interview_start_returns_prompt_guidance():
    result = build_deep_interview(DeepInterviewRequest(brief='收敛需求'))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.meta.handoff.recommended_next_action == 'ydeep_menu'
    assert result.meta.handoff.options[0].value == 'ydeep_menu'
    assert 'Task / Arguments:' in result.artifacts.skill_content


def test_deep_interview_complete_returns_clarified_artifact_and_handoff():
    result = build_deep_interview_complete(
        DeepInterviewCompleteRequest(
            summary='已完成需求调研总结',
            brief='收敛需求',
        )
    )
    assert result.status is ToolStatus.OK
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert result.artifacts.suggested_prompt == 'workflow-menu'
    assert 'Workflow Menu' in result.artifacts.skill_content
    assert result.artifacts.clarified_artifact.summary == '已完成需求调研总结'
    assert result.artifacts.selected_option is None
    assert {item.value for item in result.artifacts.handoff_options} == {'yplan', 'refine_further'}
    assert result.artifacts.workflow_state.current_phase == 'ready_for_handoff'
    assert result.artifacts.workflow_state.readiness == 'ready_for_handoff'
    assert result.artifacts.workflow_state.current_focus == 'elicitation_requested'


def test_deep_interview_complete_records_valid_selected_option():
    result = build_deep_interview_complete(
        DeepInterviewCompleteRequest(
            summary='已完成需求调研总结',
            selected_option='yplan',
        )
    )
    assert result.status is ToolStatus.OK
    assert result.meta.required_host_action is HostActionType.DISPLAY_ONLY
    assert result.meta.elicitation_selected_option == 'yplan'
    assert result.artifacts.selected_option == 'yplan'
    assert result.artifacts.workflow_state.current_phase == 'selection_confirmed'


def test_ralplan_start_returns_planner_prompt():
    result = build_ralplan(RalplanRequest(task='恢复架构'))
    assert result.artifacts.suggested_prompt == 'planner'
    assert result.meta.handoff.recommended_next_action == 'yplan_architect'
    assert 'Task / Arguments:' in result.artifacts.skill_content


def test_ralplan_can_start_from_task_derived_from_clarified_artifact():
    interview = build_deep_interview_complete(
        DeepInterviewCompleteRequest(summary='从澄清结果进入规划', brief='从需求澄清开始')
    )
    result = build_ralplan(RalplanRequest(task=interview.artifacts.clarified_artifact.summary))
    assert '从澄清结果进入规划' in result.artifacts.skill_content


def test_ralplan_can_restart_from_fresh_plain_task():
    result = build_ralplan(RalplanRequest(task='执行后重规划'))
    assert '执行后重规划' in result.artifacts.skill_content


def test_ralplan_complete_summary_explains_each_option():
    result = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准，验收和验证路径明确'))
    assert '不继续分析' in result.summary
    assert result.artifacts.suggested_prompt == 'workflow-menu'
    assert 'meta.handoff.options' in result.artifacts.skill_content
    assert '不生成最终业务结论' in result.summary
    assert '唯一权威菜单数据源' in result.summary
    assert '真实交互控件' in result.summary
    assert 'assistant 不得用自然语言或 markdown 列表代渲染选项' in result.summary
    assert '选择 `ydo`' not in result.summary
    assert '必须保留每个选项的 value/title/recommended' in result.summary
    assert '不要求逐字多行还原' in result.summary


def test_ralph_start_summary_explains_context_based_execution():
    result = build_ralph(RalphRequest())
    assert '不再要求' in result.summary
    assert '当前调用链上下文' in result.summary


def test_ralph_complete_summary_explains_each_option():
    result = build_ralph_complete(RalphCompleteRequest())
    assert result.artifacts.suggested_prompt == 'workflow-menu'
    assert 'selected_option' in result.artifacts.skill_content
    assert '真实交互控件' in result.summary
    assert 'markdown 列表' in result.summary
    assert '唯一权威菜单数据源' in result.summary


def test_ralplan_architect_returns_architect_prompt():
    result = build_ralplan_architect(RalplanArchitectRequest())
    assert result.artifacts.suggested_prompt == 'architect'
    assert result.meta.handoff.recommended_next_action == 'yplan_critic'
    assert 'architect_summary' in result.summary
    assert '不要空参调用 yplan_critic' in result.summary
    assert '同一轮立即调用 `yplan_critic`' in result.summary
    assert '只输出摘要但不调用 yplan_critic 是协议违规' in result.summary


def test_ralplan_critic_returns_restart_and_complete_options():
    result = build_ralplan_critic(RalplanCriticRequest(architect_summary='架构评估已完成，边界、tradeoff、风险明确'))
    assert result.artifacts.suggested_prompt == 'critic'
    assert result.artifacts.architect_summary == '架构评估已完成，边界、tradeoff、风险明确'
    assert result.meta.handoff.recommended_next_action is None
    assert {item.value for item in result.meta.handoff.options} == {'yplan', 'yplan_menu'}
    assert '必须选择 `yplan` 重开规划' in result.summary
    assert 'critic_summary' in result.summary
    assert '不要空参调用 `yplan_menu`' in result.summary


def test_ralplan_critic_blocks_empty_call_until_architect_summary():
    result = build_ralplan_critic(RalplanCriticRequest())
    assert result.status is ToolStatus.BLOCKED
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert result.meta.handoff.recommended_next_action is None
    assert result.meta.handoff.options[0].value == 'yplan_architect'
    assert result.artifacts.skill_content == ''
    assert result.artifacts.workflow_state.current_phase == 'architect_summary_required'
    assert result.artifacts.workflow_state.blocked_reason == 'architect_summary_required'
    assert '不能空参进入' in result.summary
    assert '不会继续到 yplan_menu' in result.summary


def test_ralplan_complete_exposes_handoff_options():
    result = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准，验收和验证路径明确'))
    assert result.status is ToolStatus.OK
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert {item.value for item in result.artifacts.handoff_options} >= {'ydo', 'restart', 'memory_store'}
    assert result.artifacts.selected_option is None
    assert result.artifacts.workflow_state.current_phase == 'ready_for_handoff'
    assert result.artifacts.workflow_state.readiness == 'ready_for_handoff'
    assert result.artifacts.workflow_state.current_focus == 'elicitation_requested'


def test_ralplan_complete_blocks_empty_complete_call_until_critic_summary():
    result = build_ralplan_complete(RalplanCompleteRequest())
    assert result.status is ToolStatus.BLOCKED
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert result.meta.handoff.recommended_next_action is None
    assert result.meta.handoff.options[0].value == 'yplan_critic'
    assert result.artifacts.handoff_options == []
    assert result.artifacts.workflow_state.current_phase == 'critic_summary_required'
    assert result.artifacts.workflow_state.blocked_reason == 'critic_summary_required'
    assert '不能空参收口' in result.summary
    assert '不会进入执行菜单' in result.summary


def test_ralplan_complete_records_valid_selected_option():
    result = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准', selected_option='memory_store'))
    assert result.status is ToolStatus.OK
    assert result.meta.required_host_action is HostActionType.DISPLAY_ONLY
    assert result.meta.elicitation_selected_option == 'memory_store'
    assert result.meta.handoff.recommended_next_action == 'memory_store'
    assert result.artifacts.selected_option == 'memory_store'
    assert result.artifacts.workflow_state.current_phase == 'selection_confirmed'
    assert result.artifacts.workflow_state.current_focus == 'selected:memory_store'


def test_ralplan_complete_blocks_invalid_selected_option():
    result = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准', selected_option='invalid'))
    assert result.status is ToolStatus.BLOCKED
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert result.artifacts.selected_option is None
    assert result.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
    assert result.artifacts.workflow_state.current_focus == 'invalid_selected_option'
    assert '非法 selected_option' in result.summary


def test_ralph_start_returns_prompt_guidance():
    result = build_ralph(RalphRequest())
    assert result.artifacts.suggested_prompt == 'ralph'
    assert result.meta.handoff.recommended_next_action == 'ydo_menu'
    assert result.meta.handoff.options[0].value == 'ydo_menu'
    assert 'Task / Arguments:' in result.artifacts.skill_content


def test_ralph_complete_exposes_finish_memory_plan_and_continue():
    result = build_ralph_complete(RalphCompleteRequest())
    assert result.artifacts.execution_verdict == 'complete'
    assert result.status is ToolStatus.OK
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert {item.value for item in result.artifacts.handoff_options} >= {'finish', 'memory_store', 'yplan', 'continue_execution'}
    assert result.artifacts.selected_option is None
    assert {item.value for item in result.artifacts.handoff_options} == {'finish', 'memory_store', 'yplan', 'continue_execution'}
    assert result.artifacts.workflow_state.current_phase == 'ready_for_handoff'
    assert result.artifacts.workflow_state.readiness == 'ready_for_handoff'
    assert result.artifacts.workflow_state.current_focus == 'elicitation_requested'


def test_ralph_complete_records_valid_selected_option():
    result = build_ralph_complete(RalphCompleteRequest(selected_option='continue_execution'))
    assert result.status is ToolStatus.OK
    assert result.meta.required_host_action is HostActionType.DISPLAY_ONLY
    assert result.meta.elicitation_selected_option == 'continue_execution'
    assert result.artifacts.selected_option == 'continue_execution'
    assert result.artifacts.workflow_state.current_phase == 'selection_confirmed'


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

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
    assert result.meta.handoff.recommended_next_action == 'ydeep_complete'
    assert result.meta.handoff.options[0].value == 'ydeep_complete'
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
    assert result.artifacts.clarified_artifact.summary == '已完成需求调研总结'
    assert result.artifacts.selected_option is None
    assert {item.value for item in result.artifacts.handoff_options} == {'yplan', 'refine_further'}


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
    result = build_ralplan_complete(RalplanCompleteRequest())
    assert 'ydo' in result.summary
    assert 'restart' in result.summary
    assert 'memory_store' in result.summary
    assert '不继续分析' in result.summary
    assert '不生成最终业务结论' in result.summary
    assert '唯一权威菜单数据源' in result.summary
    assert '不得省略、改写、新增' in result.summary


def test_ralph_start_summary_explains_context_based_execution():
    result = build_ralph(RalphRequest())
    assert '不再要求' in result.summary
    assert '当前调用链上下文' in result.summary


def test_ralph_complete_summary_explains_each_option():
    result = build_ralph_complete(RalphCompleteRequest())
    assert 'finish' in result.summary
    assert 'memory_store' in result.summary
    assert 'yplan' in result.summary
    assert 'continue_execution' in result.summary
    assert '唯一权威菜单数据源' in result.summary


def test_ralplan_architect_returns_architect_prompt():
    result = build_ralplan_architect(RalplanArchitectRequest())
    assert result.artifacts.suggested_prompt == 'architect'
    assert result.meta.handoff.recommended_next_action == 'yplan_critic'


def test_ralplan_critic_returns_restart_and_complete_options():
    result = build_ralplan_critic(RalplanCriticRequest())
    assert result.artifacts.suggested_prompt == 'critic'
    assert result.meta.handoff.recommended_next_action is None
    assert {item.value for item in result.meta.handoff.options} == {'yplan', 'yplan_complete'}
    assert '必须选择 `yplan` 重开规划' in result.summary
    assert '不要在写完批准结论后直接结束当前轮' in result.summary
    assert '不要把 `yplan_complete` 当成最终分析结论步骤' in result.summary


def test_ralplan_complete_exposes_handoff_options():
    result = build_ralplan_complete(RalplanCompleteRequest())
    assert result.status is ToolStatus.OK
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert {item.value for item in result.artifacts.handoff_options} >= {'ydo', 'restart', 'memory_store'}
    assert result.artifacts.selected_option is None
    assert result.artifacts.workflow_state.readiness == 'ready'


def test_ralph_start_returns_prompt_guidance():
    result = build_ralph(RalphRequest())
    assert result.artifacts.suggested_prompt == 'ralph'
    assert result.meta.handoff.recommended_next_action == 'ydo_complete'
    assert result.meta.handoff.options[0].value == 'ydo_complete'
    assert 'Task / Arguments:' in result.artifacts.skill_content


def test_ralph_complete_exposes_finish_memory_plan_and_continue():
    result = build_ralph_complete(RalphCompleteRequest())
    assert result.artifacts.execution_verdict == 'complete'
    assert result.status is ToolStatus.OK
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert {item.value for item in result.artifacts.handoff_options} >= {'finish', 'memory_store', 'yplan', 'continue_execution'}
    assert result.artifacts.selected_option is None
    assert {item.value for item in result.artifacts.handoff_options} == {'finish', 'memory_store', 'yplan', 'continue_execution'}


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

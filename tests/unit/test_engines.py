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
    assert result.artifacts.readiness_verdict == 'prompt_required'
    assert result.artifacts.completion_tool == 'ydeep_complete'
    assert 'Task / Arguments:' in result.artifacts.skill_content


def test_deep_interview_complete_ready_requires_user_choice():
    result = build_deep_interview_complete(DeepInterviewCompleteRequest(brief='收敛需求', summary='已完成需求调研总结'))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert result.meta.requires_explicit_user_choice is True


def test_ralplan_start_returns_planner_prompt():
    result = build_ralplan(RalplanRequest(task='恢复架构'))
    assert result.artifacts.suggested_prompt == 'planner'
    assert result.artifacts.next_tool == 'yplan_architect'
    assert 'Task / Arguments:' in result.artifacts.skill_content


def test_ralplan_architect_returns_architect_prompt():
    result = build_ralplan_architect(RalplanArchitectRequest(task='恢复架构', plan_summary='方案草案', planner_notes=['规划完成']))
    assert result.artifacts.suggested_prompt == 'architect'
    assert result.artifacts.next_tool == 'yplan_critic'
    assert 'Task / Arguments:' in result.artifacts.skill_content


def test_ralplan_critic_returns_critic_prompt():
    result = build_ralplan_critic(RalplanCriticRequest(task='恢复架构', plan_summary='方案草案', planner_notes=['规划完成'], architect_notes=['架构审查完成'], critic_verdict='APPROVE'))
    assert result.artifacts.suggested_prompt == 'critic'
    assert result.artifacts.next_tool == 'yplan_complete'
    assert 'Task / Arguments:' in result.artifacts.skill_content


def test_ralplan_critic_accepts_multiline_approve_verdict():
    result = build_ralplan_critic(RalplanCriticRequest(task='恢复架构', plan_summary='方案草案', planner_notes=['规划完成'], architect_notes=['架构审查完成'], critic_verdict='APPROVE\n\n详细评审内容'))
    assert result.artifacts.readiness_verdict == 'approved'
    assert result.artifacts.next_tool == 'yplan_complete'


def test_ralplan_critic_revise_does_not_allow_complete():
    result = build_ralplan_critic(RalplanCriticRequest(task='恢复架构', plan_summary='方案草案', planner_notes=['规划完成'], architect_notes=['架构审查完成'], critic_verdict='REVISE', critic_notes=['需补充缓存失效策略']))
    assert result.artifacts.readiness_verdict == 'needs_revision'
    assert result.artifacts.next_tool is None


def test_ralplan_complete_exposes_ralph_restart_and_memory_options():
    result = build_ralplan_complete(RalplanCompleteRequest(task='恢复架构', summary='已完成方案总结', critic_verdict='APPROVE', plan_summary='方案已完成'))
    assert result.meta.requires_explicit_user_choice is True
    assert {item.value for item in result.artifacts.handoff_options} >= {'ydo', 'restart', 'memory_store'}


def test_ralplan_complete_accepts_multiline_approve_verdict():
    result = build_ralplan_complete(RalplanCompleteRequest(task='恢复架构', summary='已完成方案总结', critic_verdict='APPROVE\n\n详细评审内容', plan_summary='方案已完成'))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.consensus_verdict == 'approved'


def test_ralplan_complete_blocks_non_approved_critic():
    result = build_ralplan_complete(RalplanCompleteRequest(task='恢复架构', summary='仍需修订', critic_verdict='REVISE', plan_summary='方案未完成'))
    assert result.status is ToolStatus.BLOCKED
    assert result.artifacts.consensus_verdict == 'needs_revision'


def test_ralph_start_returns_completion_tool():
    result = build_ralph(RalphRequest(approved_plan='执行'))
    assert result.artifacts.suggested_prompt == 'ralph'
    assert result.artifacts.completion_tool == 'ydo_complete'
    assert 'Task / Arguments:' in result.artifacts.skill_content


def test_ralph_complete_exposes_finish_memory_plan_and_continue():
    result = build_ralph_complete(RalphCompleteRequest(approved_plan='执行', summary='已完成执行总结'))
    assert result.artifacts.execution_verdict == 'complete'
    assert result.meta.requires_explicit_user_choice is True
    assert {item.value for item in result.artifacts.handoff_options} >= {'finish', 'memory_store', 'yplan', 'continue_execution'}


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

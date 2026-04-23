import ast
from pathlib import Path

import pytest

from ymcp.contracts.common import ToolStatus
from ymcp.contracts.deep_interview import DeepInterviewRequest
from ymcp.contracts.plan import PlanRequest
from ymcp.contracts.ralplan import RalplanRequest
from ymcp.contracts.ralph import RalphRequest
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.plan import build_plan
from ymcp.engine.ralplan import build_ralplan
from ymcp.engine.ralph import build_ralph


def test_plan_engine_direct_mode_requests_standard_next_step_input():
    request = PlanRequest(task="为 Ymcp 增加状态机工作流输出", constraints=["宿主控制执行"])
    result = build_plan(request)
    assert result.status is ToolStatus.OK
    assert result.artifacts.workflow_state.current_phase == "direct_plan"
    assert result.artifacts.requested_input is not None
    assert result.artifacts.recommended_next_tool is None
    assert result.artifacts.workflow_state.memory_preflight.required is True


def test_plan_engine_vague_task_requests_interview():
    result = build_plan(PlanRequest(task="改好它"))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.recommended_next_tool == "deep_interview"
    assert result.artifacts.requested_input is not None


def test_plan_engine_auto_mode_handles_clear_chinese_tasks():
    result = build_plan(PlanRequest(task="优化项目稳定性"))
    assert result.status is ToolStatus.OK
    assert result.artifacts.workflow_state.current_phase == "direct_plan"


def test_deep_interview_engine_needs_input_until_gates_resolved():
    result = build_deep_interview(DeepInterviewRequest(brief="Build MCP workflows"))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.workflow_state.readiness == "needs_input"
    assert result.artifacts.readiness_gates.non_goals == "needs_clarification"
    assert result.artifacts.next_question is not None
    assert result.artifacts.requested_input is not None
    assert result.artifacts.workflow_state.memory_preflight.required is True
    assert result.artifacts.workflow_state.memory_preflight.suggested_tool == "memory_search"


def test_deep_interview_engine_can_crystallize():
    request = DeepInterviewRequest(
        brief="为 Ymcp 的工作流工具建立状态机投影",
        prior_rounds=[
            {"question": "Q1", "answer": "解决宿主难以继续推进的问题"},
            {"question": "Q2", "answer": "第一版不直接执行命令"},
            {"question": "Q3", "answer": "输出必须可交给 Trae"},
            {"question": "Q4", "answer": "验收标准要可测试"},
            {"question": "Q5", "answer": "保留现有工具名"},
        ],
        non_goals=["不做 agent runtime"],
        decision_boundaries=["宿主负责循环和执行"],
        known_context=["当前已有 4 个 workflow tools"],
        profile="quick",
    )
    result = build_deep_interview(request)
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.spec_skeleton is not None
    assert result.artifacts.workflow_state.current_phase == "handoff_selection"
    assert result.artifacts.workflow_state.readiness == "needs_user_choice"
    assert result.artifacts.requested_input is not None
    assert result.artifacts.selected_next_tool is None
    assert {option.id for option in result.artifacts.handoff_options} == {"ralplan", "plan", "ralph", "refine_further"}
    assert next(option for option in result.artifacts.handoff_options if option.id == "ralplan").recommended is True


def test_deep_interview_crystallize_does_not_auto_select_next_tool():
    result = build_deep_interview(
        DeepInterviewRequest(
            brief="为 Ymcp 的工作流工具建立状态机投影",
            prior_rounds=[
                {"question": "Q1", "answer": "解决宿主难以继续推进的问题"},
                {"question": "Q2", "answer": "第一版不直接执行命令"},
                {"question": "Q3", "answer": "输出必须可交给 Trae"},
            ],
            non_goals=["不做 agent runtime"],
            decision_boundaries=["宿主负责循环和执行"],
            known_context=["当前已有 4 个 workflow tools"],
            profile="quick",
        )
    )
    assert result.artifacts.selected_next_tool is None
    assert "自动调用 plan、ralplan 或 ralph" in result.artifacts.requested_input


def test_ralplan_engine_returns_architect_review_first():
    result = build_ralplan(RalplanRequest(task="规划 Ymcp workflow refactor"))
    assert result.status is ToolStatus.OK
    assert result.artifacts.workflow_state.current_phase == "planner_draft"
    assert result.artifacts.architect_review_prompt
    assert result.artifacts.workflow_state.memory_preflight.required is True


def test_ralplan_engine_requires_revision_when_critic_feedback_present():
    result = build_ralplan(RalplanRequest(task="规划 Ymcp workflow refactor", current_phase="critic_review", critic_feedback=["补充测试"]))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.workflow_state.current_phase == "revise"
    assert result.artifacts.critic_verdict == "REVISE"


def test_ralplan_engine_approves_and_requests_standard_next_step():
    result = build_ralplan(RalplanRequest(task="规划 Ymcp workflow refactor", current_phase="critic_review"))
    assert result.status is ToolStatus.OK
    assert result.artifacts.workflow_state.current_phase == "approved"
    assert result.artifacts.approved_plan_summary is not None
    assert result.artifacts.requested_input is not None
    assert {option.id for option in result.artifacts.handoff_options} == {"ralph", "plan", "memory_store"}
    assert next(option for option in result.artifacts.handoff_options if option.id == "ralph").recommended is True


def test_ralph_engine_requires_evidence_and_verification():
    result = build_ralph(RalphRequest(approved_plan="Do the plan"))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert "latest_evidence" in result.artifacts.missing_evidence
    assert result.artifacts.requested_input is not None


def test_ralph_engine_detects_failures():
    result = build_ralph(RalphRequest(approved_plan="Do the plan", latest_evidence=["测试失败"], verification_commands=["pytest"], known_failures=["单元测试失败"]))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.workflow_state.readiness == "fixing"
    assert result.artifacts.requested_input is None


def test_engines_do_not_use_subprocess_or_file_mutation_calls():
    engine_dir = Path("src/ymcp/engine")
    forbidden_names = {"subprocess", "Popen", "system", "remove", "unlink", "rmdir", "write_text", "open"}
    for path in engine_dir.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                assert node.id not in forbidden_names, f"{path} uses forbidden name {node.id}"
            if isinstance(node, ast.Attribute):
                assert node.attr not in forbidden_names, f"{path} uses forbidden attr {node.attr}"



def test_ralplan_engine_approves_when_feedback_contains_approve():
    feedback = ["Critic 审查意见：存在一些建议，但最终结论：APPROVE - 计划已足够清晰，可以进入执行阶段。"]
    result = build_ralplan(RalplanRequest(task="规划 Ymcp workflow refactor", current_phase="critic_review", critic_feedback=feedback))
    assert result.status is ToolStatus.OK
    assert result.artifacts.workflow_state.current_phase == "approved"
    assert result.artifacts.critic_verdict == "APPROVE"


def test_ralplan_engine_honors_explicit_critic_verdict():
    result = build_ralplan(RalplanRequest(task="规划 Ymcp workflow refactor", current_phase="critic_review", critic_feedback=["有一些建议"], critic_verdict_input="APPROVE"))
    assert result.artifacts.critic_verdict == "APPROVE"



def test_ralplan_request_allows_iteration_up_to_twelve():
    result = build_ralplan(
        RalplanRequest(
            task="分析预加载功能模块和 combattext 缓存机制",
            current_phase="critic_review",
            critic_feedback=["Critic 最终评估通过。计划清晰，测试性良好，风险可控。建议进入实施阶段。"],
            iteration=12,
        )
    )
    assert result.status is ToolStatus.OK
    assert result.artifacts.critic_verdict == "APPROVE"
    assert result.artifacts.workflow_state.current_phase == "approved"



def test_ralplan_request_rejects_iteration_above_twelve():
    with pytest.raises(ValueError):
        RalplanRequest(task="规划功能", iteration=13)



def test_ralph_engine_complete_requests_next_step_choice():
    result = build_ralph(RalphRequest(approved_plan="Do the plan", current_phase="complete", latest_evidence=["pytest passed"], verification_commands=["pytest"]))
    assert result.status is ToolStatus.OK
    assert result.artifacts.stop_continue_judgement == "complete"
    assert result.artifacts.requested_input is not None



def test_memory_preflight_satisfied_when_context_present():
    plan = build_plan(PlanRequest(task="实现功能", known_context=["用户偏好中文"]))
    assert plan.artifacts.workflow_state.memory_preflight.already_satisfied is True
    assert plan.artifacts.workflow_state.memory_preflight.required is False

    interview = build_deep_interview(DeepInterviewRequest(brief="实现功能", known_context=["历史约定"]))
    assert interview.artifacts.workflow_state.memory_preflight.already_satisfied is True



def test_memory_preflight_counts_only_actual_memory_hits():
    no_result = ["记忆检索：未找到与“实现功能”相关的长期记忆。"]
    failed = ["记忆检索：失败：连接失败"]
    hit = ["记忆检索：1. 用户偏好中文输出"]

    plan_no_result = build_plan(PlanRequest(task="实现功能", known_context=no_result))
    assert plan_no_result.artifacts.workflow_state.memory_preflight.search_performed is True
    assert plan_no_result.artifacts.workflow_state.memory_preflight.retrieved_count == 0
    assert plan_no_result.artifacts.workflow_state.memory_preflight.retrieved_context == []

    interview_failed = build_deep_interview(DeepInterviewRequest(brief="实现功能", known_context=failed))
    assert interview_failed.artifacts.workflow_state.memory_preflight.search_performed is True
    assert interview_failed.artifacts.workflow_state.memory_preflight.retrieved_count == 0

    ralplan_hit = build_ralplan(RalplanRequest(task="规划功能", known_context=hit))
    assert ralplan_hit.artifacts.workflow_state.memory_preflight.search_performed is True
    assert ralplan_hit.artifacts.workflow_state.memory_preflight.retrieved_count == 1
    assert ralplan_hit.artifacts.workflow_state.memory_preflight.retrieved_context == hit

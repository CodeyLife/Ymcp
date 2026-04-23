import ast
from pathlib import Path

from ymcp.contracts.common import ToolStatus
from ymcp.contracts.deep_interview import DeepInterviewRequest
from ymcp.contracts.plan import PlanRequest
from ymcp.contracts.ralplan import RalplanRequest
from ymcp.contracts.ralph import RalphRequest
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.plan import build_plan
from ymcp.engine.ralplan import build_ralplan
from ymcp.engine.ralph import build_ralph


def test_plan_engine_direct_mode():
    request = PlanRequest(task="为 Ymcp 增加状态机工作流输出", constraints=["宿主控制执行"])
    result = build_plan(request)
    assert result.status is ToolStatus.OK
    assert result.artifacts.workflow_state.current_phase == "direct_plan"
    assert result.artifacts.workflow_state.host_next_action
    assert result.artifacts.continuation.interaction_mode == "continue_workflow"
    assert result.artifacts.workflow_state.memory_preflight.required is True
    assert result.artifacts.continuation.selection_required is True
    assert {option.tool for option in result.artifacts.continuation.handoff_options} >= {"ralph", "ralplan", "deep_interview"}


def test_plan_engine_vague_task_requests_interview():
    result = build_plan(PlanRequest(task="改好它"))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.recommended_next_tool == "deep_interview"
    assert result.artifacts.continuation.continuation_kind == "handoff_to_tool"


def test_deep_interview_engine_needs_input_until_gates_resolved():
    result = build_deep_interview(DeepInterviewRequest(brief="Build MCP workflows"))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.workflow_state.readiness == "needs_input"
    assert result.artifacts.readiness_gates.non_goals == "needs_clarification"
    assert result.artifacts.interaction_mode == "ask_user"
    assert result.artifacts.answer_options
    assert "不要在提问后结束对话" in result.artifacts.continuation_instruction
    assert result.artifacts.continuation.continuation_kind == "user_answer"
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
    assert result.status is ToolStatus.OK
    assert result.artifacts.crystallize_ready is True
    assert result.artifacts.workflow_state.handoff_target == "ralplan"
    assert result.artifacts.continuation.interaction_mode == "handoff"
    assert result.artifacts.continuation.selection_required is True
    assert {option.tool for option in result.artifacts.continuation.handoff_options} >= {"ralplan", "plan", "ralph"}


def test_ralplan_engine_returns_architect_review_first():
    result = build_ralplan(RalplanRequest(task="规划 Ymcp workflow refactor"))
    assert result.status is ToolStatus.OK
    assert result.artifacts.workflow_state.current_phase == "planner_draft"
    assert result.artifacts.architect_review_prompt
    assert result.artifacts.continuation.continuation_kind == "next_phase"
    assert result.artifacts.workflow_state.memory_preflight.required is True


def test_ralplan_engine_requires_revision_when_critic_feedback_present():
    result = build_ralplan(RalplanRequest(task="规划 Ymcp workflow refactor", current_phase="critic_review", critic_feedback=["补充测试"] ))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.workflow_state.current_phase == "revise"
    assert result.artifacts.critic_verdict == "REVISE"
    assert result.artifacts.continuation.continuation_kind == "next_phase"


def test_ralplan_engine_approves_and_handoffs_to_ralph():
    result = build_ralplan(RalplanRequest(task="规划 Ymcp workflow refactor", current_phase="critic_review"))
    assert result.status is ToolStatus.OK
    assert result.artifacts.workflow_state.handoff_target == "ralph"
    assert result.artifacts.handoff_contract is not None
    assert result.artifacts.continuation.interaction_mode == "handoff"
    assert result.artifacts.continuation.selection_required is True
    assert {option.tool for option in result.artifacts.continuation.handoff_options} >= {"ralph", "plan", "memory_store"}


def test_ralph_engine_requires_evidence_and_verification():
    result = build_ralph(RalphRequest(approved_plan="Do the plan"))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert "latest_evidence" in result.artifacts.missing_evidence
    assert result.artifacts.continuation.continuation_kind == "provide_evidence"


def test_ralph_engine_detects_failures():
    result = build_ralph(RalphRequest(approved_plan="Do the plan", latest_evidence=["测试失败"], verification_commands=["pytest"], known_failures=["单元测试失败"]))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.workflow_state.readiness == "fixing"
    assert result.artifacts.continuation.continuation_kind == "fix_failures"


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
    assert result.artifacts.workflow_state.handoff_target == "ralph"


def test_ralplan_engine_honors_explicit_critic_verdict():
    result = build_ralplan(RalplanRequest(task="规划 Ymcp workflow refactor", current_phase="critic_review", critic_feedback=["有一些建议"], critic_verdict_input="APPROVE"))
    assert result.artifacts.critic_verdict == "APPROVE"
    assert result.artifacts.handoff_contract is not None



def test_ralph_engine_complete_returns_next_step_options():
    result = build_ralph(RalphRequest(approved_plan="Do the plan", current_phase="complete", latest_evidence=["pytest passed"], verification_commands=["pytest"]))
    assert result.status is ToolStatus.OK
    assert result.artifacts.continuation.interaction_mode == "complete"
    assert result.artifacts.continuation.selection_required is True
    assert {option.tool for option in result.artifacts.continuation.handoff_options} >= {"memory_store", "plan", None}



def test_memory_preflight_satisfied_when_context_present():
    plan = build_plan(PlanRequest(task="实现功能", known_context=["用户偏好中文"]))
    assert plan.artifacts.workflow_state.memory_preflight.already_satisfied is True
    assert plan.artifacts.workflow_state.memory_preflight.required is False

    interview = build_deep_interview(DeepInterviewRequest(brief="实现功能", known_context=["历史约定"]))
    assert interview.artifacts.workflow_state.memory_preflight.already_satisfied is True

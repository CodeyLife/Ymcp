import ast
from pathlib import Path

from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.deep_interview import DeepInterviewRequest
from ymcp.contracts.plan import PlanRequest
from ymcp.contracts.ralplan import RalplanArchitectRequest, RalplanCriticRequest, RalplanHandoffRequest, RalplanPlannerRequest, RalplanRequest
from ymcp.contracts.ralph import RalphRequest
from ymcp.core.result import apply_selected_tool_handoff
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.plan import build_plan
from ymcp.engine.ralplan import build_ralplan, build_ralplan_architect, build_ralplan_critic, build_ralplan_handoff, build_ralplan_planner
from ymcp.engine.ralph import build_ralph


def test_plan_output_is_minimal_and_clear():
    result = build_plan(PlanRequest(task="为 Ymcp 增加状态机工作流输出", constraints=["宿主控制执行"]))
    assert result.status is ToolStatus.OK
    assert result.artifacts.plan_markdown_draft
    assert result.artifacts.selected_next_tool is None


def test_deep_interview_output_is_minimal_and_clear():
    result = build_deep_interview(DeepInterviewRequest(brief="Build MCP workflows"))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.next_question is not None
    assert result.artifacts.spec_skeleton is None
    assert result.artifacts.ambiguity_score is not None
    assert result.artifacts.readiness_gates is not None


def test_deep_interview_brownfield_requires_host_context_instead_of_user_repo_guessing():
    result = build_deep_interview(DeepInterviewRequest(brief="Refactor the existing router", context_type="brownfield"))
    assert result.artifacts.workflow_state.readiness == "needs_host_context"
    assert result.artifacts.next_question is None
    assert any("repo_findings" in gap for gap in result.artifacts.workflow_state.evidence_gaps)


def test_deep_interview_does_not_crystallize_until_pressure_pass_is_complete():
    result = build_deep_interview(
        DeepInterviewRequest(
            brief="Build MCP workflows",
            non_goals=["不直接执行命令"],
            decision_boundaries=["UI 文案可由宿主决定"],
            prior_rounds=[
                {"question": "Round 1 | Target: intent | Ambiguity: 80%\n\n你最希望这个需求解决的核心痛点是什么？", "answer": "希望宿主不再误结束。"},
                {"question": "Round 2 | Target: outcome | Ambiguity: 60%\n\n完成后最小可验证结果是什么？", "answer": "宿主能持续推进到 handoff。"},
            ],
        )
    )
    assert result.artifacts.readiness_gates.pressure_pass_complete is False
    assert result.artifacts.spec_skeleton is None


def test_deep_interview_can_crystallize_with_execution_spec_and_handoffs():
    result = build_deep_interview(
        DeepInterviewRequest(
            brief="Build MCP workflows",
            non_goals=["不直接执行命令"],
            decision_boundaries=["文案细节可由宿主决定"],
            known_context=["workflow server"],
            repo_findings=["src/ymcp/server.py exposes elicitation hooks"],
            prior_rounds=[
                {"question": "Round 1 | Target: intent | Ambiguity: 80%\n\n你最希望这个需求解决的核心痛点是什么？", "answer": "避免宿主过早结束 workflow。"},
                {"question": "Round 2 | Target: outcome | Ambiguity: 60%\n\n完成后最小可验证结果是什么？", "answer": "deep_interview 返回可交给后续 workflow 的规格。"},
                {"question": "Round 3 | Target: success | Ambiguity: 40%\n\n请给出 2-3 条可测试的验收标准。", "answer": "- 返回 execution_spec\n- 返回 handoff_contracts"},
                {"question": "Round 4 | Target: success | Ambiguity: 30%\n\n请给出 2-3 条可测试的验收标准。", "answer": "- 需要显式用户选择下一步 workflow"},
            ],
        )
    )
    assert result.artifacts.spec_skeleton is not None
    assert result.artifacts.execution_spec is not None
    assert {item.tool for item in result.artifacts.handoff_contracts} == {"ralplan", "plan", "ralph", "refine_further"}
    assert result.artifacts.selected_next_tool is None


def test_ralplan_chain_uses_explicit_handoffs():
    kickoff = build_ralplan(RalplanRequest(task="分析 SignalR 推送链路"))
    assert kickoff.meta.selected_next_tool == "ralplan_planner"

    planner = build_ralplan_planner(RalplanPlannerRequest(task="分析 SignalR 推送链路", known_context=["CaseUpdatedHub"]))
    assert planner.meta.selected_next_tool == "ralplan_architect"
    assert planner.artifacts.planner_markdown_draft

    architect = build_ralplan_architect(RalplanArchitectRequest(task="分析 SignalR 推送链路", planner_draft=planner.artifacts.planner_markdown_draft or "draft", known_context=["CaseUpdatedHub"]))
    assert architect.meta.selected_next_tool == "ralplan_critic"
    assert architect.artifacts.architect_review

    critic = build_ralplan_critic(RalplanCriticRequest(task="分析 SignalR 推送链路", planner_draft=planner.artifacts.planner_markdown_draft or "draft", architect_review=architect.artifacts.architect_review, known_context=["CaseUpdatedHub"]))
    assert critic.artifacts.critic_verdict == "APPROVE"
    assert critic.meta.selected_next_tool == "ralplan_handoff"


def test_ralplan_handoff_minimal_and_strict():
    handoff = build_ralplan_handoff(RalplanHandoffRequest(task="分析 SignalR 推送链路", critic_verdict="APPROVE", approved_plan_summary="approved", known_context=["CaseUpdatedHub"]))
    assert handoff.status is ToolStatus.NEEDS_INPUT
    assert handoff.meta.required_host_action is HostActionType.AWAIT_INPUT
    assert handoff.meta.requires_explicit_user_choice is True
    assert handoff.artifacts.selected_next_tool is None


def test_ralplan_handoff_blocks_non_approved_flow():
    result = build_ralplan_handoff(RalplanHandoffRequest(task="分析 SignalR 推送链路", critic_verdict="REVISE", approved_plan_summary="not-approved"))
    assert result.status is ToolStatus.BLOCKED
    assert result.meta.required_host_action is HostActionType.STOP


def test_ralph_output_is_minimal_and_clear():
    result = build_ralph(RalphRequest(approved_plan="Do the plan"))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.missing_evidence == ["latest_evidence"]


def test_apply_selected_tool_handoff_marks_result_safe_for_auto_continue():
    result = build_ralplan_handoff(RalplanHandoffRequest(task="分析 SignalR 推送链路", critic_verdict="APPROVE", approved_plan_summary="approved", known_context=["CaseUpdatedHub"]))
    apply_selected_tool_handoff(result, "ralph")
    assert result.meta.required_host_action is HostActionType.CALL_SELECTED_TOOL
    assert result.meta.safe_to_auto_continue is True
    assert result.meta.selected_next_tool == "ralph"


def test_engines_do_not_use_subprocess_or_file_mutation_calls():
    engine_dir = Path("src/ymcp/engine")
    forbidden_names = {"subprocess", "Popen", "system", "remove", "unlink", "rmdir", "write_text", "open"}
    for path in engine_dir.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                assert node.id not in forbidden_names
            if isinstance(node, ast.Attribute):
                assert node.attr not in forbidden_names

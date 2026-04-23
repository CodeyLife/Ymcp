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


def test_plan_engine_deterministic():
    request = PlanRequest(problem="Ship Ymcp", constraints=["host-controlled"])
    first = build_plan(request)
    second = build_plan(request)
    assert first == second
    assert first.status is ToolStatus.OK
    assert first.artifacts.plan_steps


def test_deep_interview_engine_needs_input():
    result = build_deep_interview(DeepInterviewRequest(brief="Build MCP workflows"))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.next_question
    assert result.artifacts.ambiguity_score > 0


def test_ralplan_engine_returns_adr_and_options():
    result = build_ralplan(RalplanRequest(task="Plan Ymcp v1"))
    assert result.status is ToolStatus.OK
    assert result.artifacts.viable_options
    assert result.artifacts.adr.decision


def test_ralph_engine_requires_evidence_for_strong_judgement():
    result = build_ralph(RalphRequest(approved_plan="Do the plan"))
    assert result.status is ToolStatus.NEEDS_INPUT
    assert result.artifacts.stop_continue_judgement == "needs_more_evidence"


def test_engines_do_not_use_subprocess_or_file_mutation_calls():
    engine_dir = Path("src/ymcp/engine")
    forbidden_names = {"subprocess", "Popen", "run", "system", "remove", "unlink", "rmdir", "write_text", "open"}
    for path in engine_dir.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                assert node.id not in forbidden_names, f"{path} uses forbidden name {node.id}"
            if isinstance(node, ast.Attribute):
                assert node.attr not in forbidden_names, f"{path} uses forbidden attr {node.attr}"

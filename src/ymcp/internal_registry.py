from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Type

from pydantic import BaseModel

from ymcp.contracts.deep_interview import DeepInterviewRequest, DeepInterviewResult
from ymcp.contracts.plan import PlanRequest, PlanResult
from ymcp.contracts.ralplan import RalplanRequest, RalplanResult
from ymcp.contracts.ralph import RalphRequest, RalphResult
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.plan import build_plan
from ymcp.engine.ralplan import build_ralplan
from ymcp.engine.ralph import build_ralph


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    request_model: Type[BaseModel]
    response_model: Type[BaseModel]
    handler: Callable[[BaseModel], BaseModel]


TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="plan",
        description="Return a structured plan draft, assumptions, acceptance criteria, and next actions for the host.",
        request_model=PlanRequest,
        response_model=PlanResult,
        handler=build_plan,
    ),
    ToolSpec(
        name="ralplan",
        description="Return a consensus-planning packet with principles, drivers, options, ADR content, and test strategy for the host.",
        request_model=RalplanRequest,
        response_model=RalplanResult,
        handler=build_ralplan,
    ),
    ToolSpec(
        name="deep_interview",
        description="Returns next-question and scoring guidance only. The MCP host asks the user and owns transcript/state.",
        request_model=DeepInterviewRequest,
        response_model=DeepInterviewResult,
        handler=build_deep_interview,
    ),
    ToolSpec(
        name="ralph",
        description="Returns host next-step guidance only. Does not execute commands, spawn agents, modify files, persist loops, or verify completion itself.",
        request_model=RalphRequest,
        response_model=RalphResult,
        handler=build_ralph,
    ),
)


def get_tool_specs() -> tuple[ToolSpec, ...]:
    return TOOL_SPECS

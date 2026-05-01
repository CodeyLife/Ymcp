from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import MemoryContext, WorkflowState

RalplanPhase = Literal['start', 'planner', 'architect', 'critic']
RalplanCriticVerdict = Literal['APPROVE', 'ITERATE', 'REJECT']


class RalplanRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    phase: RalplanPhase = 'start'
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)
    planner_summary: str | None = None
    architect_summary: str | None = None
    critic_verdict: RalplanCriticVerdict | None = None
    critic_summary: str | None = None


class RalplanArtifacts(BaseModel):
    suggested_prompt: str = 'plan'
    skill_content: str
    phase: RalplanPhase = 'start'
    planner_summary: str | None = None
    architect_summary: str | None = None
    critic_verdict: RalplanCriticVerdict | None = None
    critic_summary: str | None = None
    workflow_state: WorkflowState


class RalplanResult(ToolResultBase[RalplanArtifacts]):
    artifacts: RalplanArtifacts

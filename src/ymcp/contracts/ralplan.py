from __future__ import annotations

from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import HandoffOption, MemoryContext, WorkflowPhaseSummary, WorkflowState


class RalplanRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class RalplanArchitectRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    plan_summary: str = Field(default='', min_length=0)
    planner_notes: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class RalplanCriticRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    plan_summary: str = Field(default='', min_length=0)
    planner_notes: list[str] = Field(default_factory=list)
    architect_notes: list[str] = Field(default_factory=list)
    critic_verdict: str = Field(default='', min_length=0)
    critic_notes: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class RalplanCompleteRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    summary: str = Field(..., min_length=1)
    critic_verdict: str = Field(..., min_length=1)
    plan_summary: str = Field(default='', min_length=0)
    planner_notes: list[str] = Field(default_factory=list)
    architect_notes: list[str] = Field(default_factory=list)
    critic_notes: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class RalplanArtifacts(BaseModel):
    suggested_prompt: str = 'planner'
    skill_content: str
    next_tool: str = 'yplan_architect'
    readiness_verdict: str
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary
    selected_next_tool: str | None = None


class RalplanArchitectArtifacts(BaseModel):
    suggested_prompt: str = 'architect'
    skill_content: str
    next_tool: str = 'yplan_critic'
    plan_summary: str | None = None
    planner_notes: list[str] = Field(default_factory=list)
    readiness_verdict: str
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary
    selected_next_tool: str | None = None


class RalplanCriticArtifacts(BaseModel):
    suggested_prompt: str = 'critic'
    skill_content: str
    next_tool: str | None = None
    plan_summary: str | None = None
    planner_notes: list[str] = Field(default_factory=list)
    architect_notes: list[str] = Field(default_factory=list)
    critic_verdict: str
    critic_notes: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    readiness_verdict: str
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary
    selected_next_tool: str | None = None


class RalplanCompleteArtifacts(BaseModel):
    suggested_prompt: str = 'critic'
    received_summary: str
    critic_verdict: str
    consensus_verdict: str
    approved_plan_summary: str | None = None
    planner_notes: list[str] = Field(default_factory=list)
    architect_notes: list[str] = Field(default_factory=list)
    critic_notes: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    handoff_options: list[HandoffOption] = Field(default_factory=list)
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary
    selected_next_tool: str | None = None


class RalplanResult(ToolResultBase[RalplanArtifacts]):
    artifacts: RalplanArtifacts


class RalplanArchitectResult(ToolResultBase[RalplanArchitectArtifacts]):
    artifacts: RalplanArchitectArtifacts


class RalplanCriticResult(ToolResultBase[RalplanCriticArtifacts]):
    artifacts: RalplanCriticArtifacts


class RalplanCompleteResult(ToolResultBase[RalplanCompleteArtifacts]):
    artifacts: RalplanCompleteArtifacts

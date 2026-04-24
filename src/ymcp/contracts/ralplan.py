from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import MemoryContext, WorkflowPhaseSummary, WorkflowState


class RalplanRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    constraints: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)
    deliberate: bool = False


class RalplanArtifacts(BaseModel):
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None


class RalplanResult(ToolResultBase[RalplanArtifacts]):
    artifacts: RalplanArtifacts


class RalplanPlannerRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    constraints: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)
    deliberate: bool = False


class RalplanPlannerArtifacts(BaseModel):
    planner_draft: str
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None


class RalplanPlannerResult(ToolResultBase[RalplanPlannerArtifacts]):
    artifacts: RalplanPlannerArtifacts


class RalplanArchitectRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    planner_draft: str = Field(..., min_length=1)
    constraints: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)
    deliberate: bool = False


class RalplanArchitectArtifacts(BaseModel):
    architect_review: str
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None


class RalplanArchitectResult(ToolResultBase[RalplanArchitectArtifacts]):
    artifacts: RalplanArchitectArtifacts


class RalplanCriticRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    planner_draft: str = Field(..., min_length=1)
    architect_review: str = Field(..., min_length=1)
    constraints: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)
    deliberate: bool = False


class RalplanCriticArtifacts(BaseModel):
    critic_verdict: str
    approved_plan_summary: str | None = None
    revise_instructions: list[str] = Field(default_factory=list)
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None


class RalplanCriticResult(ToolResultBase[RalplanCriticArtifacts]):
    artifacts: RalplanCriticArtifacts


class RalplanHandoffRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    approved_plan_summary: str = Field(..., min_length=1)
    critic_verdict: str = Field(..., min_length=1)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class RalplanHandoffArtifacts(BaseModel):
    approved_plan_summary: str
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None


class RalplanHandoffResult(ToolResultBase[RalplanHandoffArtifacts]):
    artifacts: RalplanHandoffArtifacts

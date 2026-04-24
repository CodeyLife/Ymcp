from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import MemoryContext, WorkflowPhaseSummary, WorkflowState


class PlanRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    mode: str = Field(default="auto")
    constraints: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)
    acceptance_criteria: list[str] = Field(default_factory=list)
    review_target: str | None = None
    desired_outcome: str | None = None


class PlanArtifacts(BaseModel):
    plan_summary: str
    acceptance_criteria: list[str] = Field(default_factory=list)
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None


class PlanResult(ToolResultBase[PlanArtifacts]):
    artifacts: PlanArtifacts

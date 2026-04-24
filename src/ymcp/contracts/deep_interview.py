from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import MemoryContext, WorkflowPhaseSummary, WorkflowState


class InterviewRound(BaseModel):
    question: str
    answer: str


class SpecSkeleton(BaseModel):
    intent: str
    desired_outcome: str
    in_scope: list[str] = Field(default_factory=list)
    non_goals: list[str] = Field(default_factory=list)
    decision_boundaries: list[str] = Field(default_factory=list)


class DeepInterviewRequest(WorkflowRequestBase):
    brief: str = Field(..., min_length=1)
    prior_rounds: list[InterviewRound] = Field(default_factory=list)
    target_threshold: float = Field(default=0.2, ge=0.0, le=1.0)
    profile: str = Field(default="standard")
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)
    non_goals: list[str] = Field(default_factory=list)
    decision_boundaries: list[str] = Field(default_factory=list)


class DeepInterviewArtifacts(BaseModel):
    next_question: str | None = None
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None
    spec_skeleton: SpecSkeleton | None = None


class DeepInterviewResult(ToolResultBase[DeepInterviewArtifacts]):
    artifacts: DeepInterviewArtifacts

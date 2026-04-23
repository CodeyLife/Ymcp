from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase


class InterviewRound(BaseModel):
    question: str
    answer: str


class DeepInterviewRequest(WorkflowRequestBase):
    brief: str = Field(..., min_length=1)
    prior_rounds: list[InterviewRound] = Field(default_factory=list)
    target_threshold: float = Field(default=0.2, ge=0.0, le=1.0)


class ReadinessGates(BaseModel):
    non_goals: str
    decision_boundaries: str
    pressure_pass: str


class DeepInterviewArtifacts(BaseModel):
    ambiguity_score: float
    weakest_dimension: str
    next_question: str
    readiness_gates: ReadinessGates
    transcript_delta: list[InterviewRound]


class DeepInterviewResult(ToolResultBase[DeepInterviewArtifacts]):
    artifacts: DeepInterviewArtifacts

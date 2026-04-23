from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import ContinuationContract, WorkflowState


class AnswerOption(BaseModel):
    label: str
    value: str
    description: str


class InterviewRound(BaseModel):
    question: str
    answer: str


class DimensionScores(BaseModel):
    intent: float = 0.0
    outcome: float = 0.0
    scope: float = 0.0
    constraints: float = 0.0
    success: float = 0.0
    context: float = 0.0


class DeepInterviewRequest(WorkflowRequestBase):
    brief: str = Field(..., min_length=1)
    prior_rounds: list[InterviewRound] = Field(default_factory=list)
    target_threshold: float = Field(default=0.2, ge=0.0, le=1.0)
    profile: str = Field(default="standard")
    known_context: list[str] = Field(default_factory=list)
    non_goals: list[str] = Field(default_factory=list)
    decision_boundaries: list[str] = Field(default_factory=list)


class ReadinessGates(BaseModel):
    non_goals: str
    decision_boundaries: str
    pressure_pass: str


class SpecSkeleton(BaseModel):
    intent: str
    desired_outcome: str
    in_scope: list[str] = Field(default_factory=list)
    non_goals: list[str] = Field(default_factory=list)
    decision_boundaries: list[str] = Field(default_factory=list)


class DeepInterviewArtifacts(BaseModel):
    interaction_mode: str = "ask_user"
    answer_options: list[AnswerOption] = Field(default_factory=list)
    continuation_instruction: str = "宿主必须把用户回答追加到 prior_rounds 后再次调用 deep_interview；不要把本轮问题视为流程结束。"
    ambiguity_score: float
    weakest_dimension: str
    next_question: str
    question_rationale: str
    readiness_gates: ReadinessGates
    scores: DimensionScores
    transcript_delta: list[InterviewRound]
    workflow_state: WorkflowState
    continuation: ContinuationContract
    crystallize_ready: bool = False
    spec_skeleton: SpecSkeleton | None = None


class DeepInterviewResult(ToolResultBase[DeepInterviewArtifacts]):
    artifacts: DeepInterviewArtifacts

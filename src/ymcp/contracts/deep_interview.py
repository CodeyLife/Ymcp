from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import ClarityScore, HandoffContract, MemoryContext, ReadinessGates, WorkflowPhaseSummary, WorkflowState


class InterviewRound(BaseModel):
    question: str
    answer: str


class SpecSkeleton(BaseModel):
    intent: str
    desired_outcome: str
    in_scope: list[str] = Field(default_factory=list)
    non_goals: list[str] = Field(default_factory=list)
    decision_boundaries: list[str] = Field(default_factory=list)


class ContextSnapshotDraft(BaseModel):
    task_statement: str
    desired_outcome: str
    stated_solution: str
    probable_intent_hypothesis: str
    known_facts: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    unknowns: list[str] = Field(default_factory=list)
    decision_boundary_unknowns: list[str] = Field(default_factory=list)
    likely_touchpoints: list[str] = Field(default_factory=list)


class QuestionStrategy(BaseModel):
    target_dimension: str
    mode: str
    rationale: str


class ExecutionSpec(BaseModel):
    profile: str
    context_type: str
    rounds: int = Field(ge=0)
    final_ambiguity: float = Field(ge=0.0, le=1.0)
    threshold: float = Field(ge=0.0, le=1.0)
    intent: str
    desired_outcome: str
    in_scope: list[str] = Field(default_factory=list)
    out_of_scope: list[str] = Field(default_factory=list)
    decision_boundaries: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    brownfield_evidence: list[str] = Field(default_factory=list)
    transcript_summary: list[str] = Field(default_factory=list)
    residual_risk: list[str] = Field(default_factory=list)


class DeepInterviewRequest(WorkflowRequestBase):
    brief: str = Field(..., min_length=1)
    prior_rounds: list[InterviewRound] = Field(default_factory=list)
    target_threshold: float = Field(default=0.2, ge=0.0, le=1.0)
    profile: str = Field(default="standard")
    known_context: list[str] = Field(default_factory=list)
    repo_findings: list[str] = Field(default_factory=list)
    context_type: str | None = None
    round_limit_override: int | None = Field(default=None, ge=1)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)
    non_goals: list[str] = Field(default_factory=list)
    decision_boundaries: list[str] = Field(default_factory=list)


class DeepInterviewArtifacts(BaseModel):
    next_question: str | None = None
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None
    spec_skeleton: SpecSkeleton | None = None
    ambiguity_score: float | None = Field(default=None, ge=0.0, le=1.0)
    clarity_breakdown: list[ClarityScore] = Field(default_factory=list)
    readiness_gates: ReadinessGates | None = None
    question_strategy: QuestionStrategy | None = None
    context_snapshot_draft: ContextSnapshotDraft | None = None
    interview_transcript_summary: list[str] = Field(default_factory=list)
    execution_spec: ExecutionSpec | None = None
    handoff_contracts: list[HandoffContract] = Field(default_factory=list)
    residual_risk: list[str] = Field(default_factory=list)


class DeepInterviewResult(ToolResultBase[DeepInterviewArtifacts]):
    artifacts: DeepInterviewArtifacts

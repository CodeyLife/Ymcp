from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import ADRSection, HandoffGuidance, MemoryContext, OptionSummary, QualityCheck, WorkflowPhaseSummary, WorkflowState


class RalplanRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    constraints: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)
    deliberate: bool = False
    review_iteration: int = Field(default=1, ge=1, le=12)
    max_iterations: int = Field(default=5, ge=1, le=12)
    feedback_bundle: list[str] = Field(default_factory=list)


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
    review_iteration: int = Field(default=1, ge=1, le=12)
    max_iterations: int = Field(default=5, ge=1, le=12)
    feedback_bundle: list[str] = Field(default_factory=list)


class RalplanPlannerArtifacts(BaseModel):
    principles: list[str] = Field(default_factory=list)
    decision_drivers: list[str] = Field(default_factory=list)
    viable_options: list[OptionSummary] = Field(default_factory=list)
    recommended_option: str | None = None
    option_invalidation_rationale: list[str] = Field(default_factory=list)
    planner_markdown_draft: str | None = None
    premortem_scenarios: list[str] = Field(default_factory=list)
    expanded_test_plan: list[str] = Field(default_factory=list)
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
    review_iteration: int = Field(default=1, ge=1, le=12)
    max_iterations: int = Field(default=5, ge=1, le=12)
    feedback_bundle: list[str] = Field(default_factory=list)


class RalplanArchitectArtifacts(BaseModel):
    architect_review: str
    steelman_counterargument: str | None = None
    tradeoff_tensions: list[str] = Field(default_factory=list)
    synthesis_path: str | None = None
    principle_violations: list[str] = Field(default_factory=list)
    architect_review_markdown: str | None = None
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
    review_iteration: int = Field(default=1, ge=1, le=12)
    max_iterations: int = Field(default=5, ge=1, le=12)
    feedback_bundle: list[str] = Field(default_factory=list)


class RalplanCriticArtifacts(BaseModel):
    critic_verdict: str
    approved_plan_summary: str | None = None
    quality_checks: list[QualityCheck] = Field(default_factory=list)
    approval_reasons: list[str] = Field(default_factory=list)
    rejection_reasons: list[str] = Field(default_factory=list)
    required_revisions: list[str] = Field(default_factory=list)
    critic_review_markdown: str | None = None
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
    approved_plan_markdown: str | None = None
    adr: ADRSection | None = None
    ralph_handoff_guidance: HandoffGuidance | None = None
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None


class RalplanHandoffResult(ToolResultBase[RalplanHandoffArtifacts]):
    artifacts: RalplanHandoffArtifacts

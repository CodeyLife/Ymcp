from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import HandoffContract, MemoryContext, QualityCheck, WorkflowPhaseSummary, WorkflowState


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
    acceptance_criteria: list[str] = Field(default_factory=list)
    requirements_summary: list[str] = Field(default_factory=list)
    implementation_steps: list[str] = Field(default_factory=list)
    risks_and_mitigations: list[str] = Field(default_factory=list)
    verification_plan: list[str] = Field(default_factory=list)
    plan_markdown_draft: str | None = None
    mode_reason: str | None = None
    quality_checks: list[QualityCheck] = Field(default_factory=list)
    review_verdict: str | None = None
    review_findings: list[str] = Field(default_factory=list)
    required_revisions: list[str] = Field(default_factory=list)
    handoff_contracts: list[HandoffContract] = Field(default_factory=list)
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None


class PlanResult(ToolResultBase[PlanArtifacts]):
    artifacts: PlanArtifacts

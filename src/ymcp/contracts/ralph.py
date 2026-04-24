from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import CompletionGate, WorkflowPhaseSummary, WorkflowState


class RalphRequest(WorkflowRequestBase):
    approved_plan: str = Field(..., min_length=1)
    latest_evidence: list[str] = Field(default_factory=list)
    current_phase: str = Field(default="executing")
    verification_commands: list[str] = Field(default_factory=list)
    verification_results: list[str] = Field(default_factory=list)
    known_failures: list[str] = Field(default_factory=list)
    regression_status: str | None = None
    architect_review_summary: str | None = None
    distillation_status: str | None = None
    execution_context_present: bool = False
    iteration: int = Field(default=1, ge=1)
    max_iterations: int = Field(default=10, ge=1)


class RalphArtifacts(BaseModel):
    stop_continue_judgement: str
    verification_checklist: list[str] = Field(default_factory=list)
    missing_evidence: list[str] = Field(default_factory=list)
    completion_gates: list[CompletionGate] = Field(default_factory=list)
    verification_summary: list[str] = Field(default_factory=list)
    evidence_freshness: str | None = None
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None


class RalphResult(ToolResultBase[RalphArtifacts]):
    artifacts: RalphArtifacts

from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import WorkflowPhaseSummary, WorkflowState


class RalphRequest(WorkflowRequestBase):
    approved_plan: str = Field(..., min_length=1)
    latest_evidence: list[str] = Field(default_factory=list)
    current_phase: str = Field(default="executing")
    verification_commands: list[str] = Field(default_factory=list)
    known_failures: list[str] = Field(default_factory=list)
    iteration: int = Field(default=1, ge=1)


class RalphArtifacts(BaseModel):
    stop_continue_judgement: str
    verification_checklist: list[str] = Field(default_factory=list)
    missing_evidence: list[str] = Field(default_factory=list)
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    selected_next_tool: str | None = None


class RalphResult(ToolResultBase[RalphArtifacts]):
    artifacts: RalphArtifacts

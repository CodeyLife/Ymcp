from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import WorkflowChoiceMenu, WorkflowPhaseSummary, WorkflowState


class RalphRequest(WorkflowRequestBase):
    approved_plan: str = Field(..., min_length=1)
    latest_evidence: list[str] = Field(default_factory=list)
    current_phase: str = Field(default="executing")
    todo_status: list[str] = Field(default_factory=list)
    verification_commands: list[str] = Field(default_factory=list)
    known_failures: list[str] = Field(default_factory=list)
    iteration: int = Field(default=1, ge=1)
    current_status: str | None = None


class RalphArtifacts(BaseModel):
    recommended_next_action: str
    verification_checklist: list[str]
    stop_continue_judgement: str
    outstanding_risks: list[str]
    missing_evidence: list[str] = Field(default_factory=list)
    reusable_memory_candidates: list[str] = Field(default_factory=list)
    skill_improvement_candidates: list[str] = Field(default_factory=list)
    final_report_skeleton: list[str] = Field(default_factory=list)
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary | None = None
    choice_menu: WorkflowChoiceMenu | None = None
    requested_input: str | None = None
    selected_next_tool: str | None = None


class RalphResult(ToolResultBase[RalphArtifacts]):
    artifacts: RalphArtifacts

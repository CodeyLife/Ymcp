from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase


class RalphRequest(WorkflowRequestBase):
    approved_plan: str = Field(..., min_length=1)
    evidence: list[str] = Field(default_factory=list)
    current_status: str | None = None


class RalphArtifacts(BaseModel):
    recommended_next_action: str
    verification_checklist: list[str]
    stop_continue_judgement: str
    outstanding_risks: list[str]


class RalphResult(ToolResultBase[RalphArtifacts]):
    artifacts: RalphArtifacts

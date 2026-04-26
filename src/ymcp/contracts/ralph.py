from __future__ import annotations

from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import HandoffOption, WorkflowPhaseSummary, WorkflowState


class RalphRequest(WorkflowRequestBase):
    approved_plan: str = Field(..., min_length=1)


class RalphCompleteRequest(WorkflowRequestBase):
    approved_plan: str = Field(..., min_length=1)
    summary: str = Field(..., min_length=1)


class RalphArtifacts(BaseModel):
    suggested_prompt: str = 'ralph'
    skill_content: str
    completion_tool: str = 'ydo_complete'
    readiness_verdict: str
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary
    selected_next_tool: str | None = None


class RalphCompleteArtifacts(BaseModel):
    suggested_prompt: str = 'ralph'
    received_summary: str
    execution_verdict: str
    handoff_options: list[HandoffOption] = Field(default_factory=list)
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary
    selected_next_tool: str | None = None


class RalphResult(ToolResultBase[RalphArtifacts]):
    artifacts: RalphArtifacts


class RalphCompleteResult(ToolResultBase[RalphCompleteArtifacts]):
    artifacts: RalphCompleteArtifacts

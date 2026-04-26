from __future__ import annotations

from pydantic import BaseModel, Field

from ymcp.contracts.common import HandoffOption, ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import MemoryContext, WorkflowPhaseSummary, WorkflowState


class RalphRequest(WorkflowRequestBase):
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class RalphCompleteRequest(WorkflowRequestBase):
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class RalphArtifacts(BaseModel):
    suggested_prompt: str = 'ralph'
    skill_content: str
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary


class RalphCompleteArtifacts(BaseModel):
    execution_verdict: str
    selected_option: str | None = None
    handoff_options: list[HandoffOption] = Field(default_factory=list)
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary


class RalphResult(ToolResultBase[RalphArtifacts]):
    artifacts: RalphArtifacts


class RalphCompleteResult(ToolResultBase[RalphCompleteArtifacts]):
    artifacts: RalphCompleteArtifacts

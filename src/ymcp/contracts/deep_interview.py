from __future__ import annotations

from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import HandoffOption, MemoryContext, WorkflowPhaseSummary, WorkflowState


class DeepInterviewRequest(WorkflowRequestBase):
    brief: str = Field(..., min_length=1)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class DeepInterviewCompleteRequest(WorkflowRequestBase):
    brief: str = Field(..., min_length=1)
    summary: str = Field(..., min_length=1)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class DeepInterviewArtifacts(BaseModel):
    suggested_prompt: str = 'deep-interview'
    skill_content: str
    completion_tool: str = 'ydeep_complete'
    prompt_required: bool = True
    readiness_verdict: str
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary
    selected_next_tool: str | None = None


class DeepInterviewCompleteArtifacts(BaseModel):
    suggested_prompt: str = 'deep-interview'
    received_summary: str
    readiness_verdict: str
    handoff_options: list[HandoffOption] = Field(default_factory=list)
    workflow_state: WorkflowState
    phase_summary: WorkflowPhaseSummary
    selected_next_tool: str | None = None


class DeepInterviewResult(ToolResultBase[DeepInterviewArtifacts]):
    artifacts: DeepInterviewArtifacts


class DeepInterviewCompleteResult(ToolResultBase[DeepInterviewCompleteArtifacts]):
    artifacts: DeepInterviewCompleteArtifacts

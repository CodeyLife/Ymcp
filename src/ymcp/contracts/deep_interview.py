from __future__ import annotations

from pydantic import BaseModel, Field

from ymcp.contracts.common import ArtifactRef, HandoffOption, ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import MemoryContext, WorkflowState


class DeepInterviewRequest(WorkflowRequestBase):
    brief: str = Field(..., min_length=1)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class DeepInterviewCompleteRequest(WorkflowRequestBase):
    summary: str = Field(..., min_length=1)
    selected_option: str | None = None
    brief: str | None = None
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class DeepInterviewHandoffArtifact(BaseModel):
    artifact_ref: ArtifactRef
    brief: str | None = None
    summary: str
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class DeepInterviewArtifacts(BaseModel):
    suggested_prompt: str = 'deep-interview'
    skill_content: str
    workflow_state: WorkflowState


class DeepInterviewCompleteArtifacts(BaseModel):
    received_summary: str
    clarified_artifact: DeepInterviewHandoffArtifact
    selected_option: str | None = None
    handoff_options: list[HandoffOption] = Field(default_factory=list)
    workflow_state: WorkflowState


class DeepInterviewResult(ToolResultBase[DeepInterviewArtifacts]):
    artifacts: DeepInterviewArtifacts


class DeepInterviewCompleteResult(ToolResultBase[DeepInterviewCompleteArtifacts]):
    artifacts: DeepInterviewCompleteArtifacts

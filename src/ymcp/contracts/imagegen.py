from __future__ import annotations

from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import MemoryContext, WorkflowState


class ImagegenRequest(WorkflowRequestBase):
    brief: str = Field(..., min_length=1)
    output_root: str | None = None
    asset_slug: str | None = None
    dimensions: str | None = None
    frame_count: int | None = Field(default=None, ge=1)
    transparent: bool = True
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class ImagegenArtifacts(BaseModel):
    suggested_prompt: str = 'imagegen'
    skill_content: str
    suggested_output_root: str
    frames_dir: str
    expected_artifacts: list[str] = Field(default_factory=list)
    transient_artifacts: list[str] = Field(default_factory=list)
    required_imports: list[str] = Field(default_factory=list)
    postprocess_steps: list[str] = Field(default_factory=list)
    validation_steps: list[str] = Field(default_factory=list)
    cleanup_steps: list[str] = Field(default_factory=list)
    completion_criteria: list[str] = Field(default_factory=list)
    workflow_state: WorkflowState


class ImagegenResult(ToolResultBase[ImagegenArtifacts]):
    artifacts: ImagegenArtifacts

from __future__ import annotations

from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import MemoryContext, WorkflowState


class RalplanRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class RalplanArtifacts(BaseModel):
    suggested_prompt: str = 'planner'
    skill_content: str
    workflow_state: WorkflowState


class RalplanResult(ToolResultBase[RalplanArtifacts]):
    artifacts: RalplanArtifacts

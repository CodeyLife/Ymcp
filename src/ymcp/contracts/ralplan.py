from __future__ import annotations

from pydantic import BaseModel, Field

from ymcp.contracts.common import HandoffOption, ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import MemoryContext, WorkflowState


class RalplanRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)


class RalplanArchitectRequest(WorkflowRequestBase):
    pass


class RalplanCriticRequest(WorkflowRequestBase):
    pass


class RalplanCompleteRequest(WorkflowRequestBase):
    pass


class RalplanArtifacts(BaseModel):
    suggested_prompt: str = 'planner'
    skill_content: str
    workflow_state: WorkflowState


class RalplanArchitectArtifacts(BaseModel):
    suggested_prompt: str = 'architect'
    skill_content: str
    workflow_state: WorkflowState


class RalplanCriticArtifacts(BaseModel):
    suggested_prompt: str = 'critic'
    skill_content: str
    workflow_state: WorkflowState


class RalplanCompleteArtifacts(BaseModel):
    selected_option: str | None = None
    handoff_options: list[HandoffOption] = Field(default_factory=list)
    workflow_state: WorkflowState


class RalplanResult(ToolResultBase[RalplanArtifacts]):
    artifacts: RalplanArtifacts


class RalplanArchitectResult(ToolResultBase[RalplanArchitectArtifacts]):
    artifacts: RalplanArchitectArtifacts


class RalplanCriticResult(ToolResultBase[RalplanCriticArtifacts]):
    artifacts: RalplanCriticArtifacts


class RalplanCompleteResult(ToolResultBase[RalplanCompleteArtifacts]):
    artifacts: RalplanCompleteArtifacts

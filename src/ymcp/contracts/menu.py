from __future__ import annotations

from pydantic import BaseModel, Field

from ymcp.contracts.common import HandoffOption, ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import WorkflowState


class MenuRequest(WorkflowRequestBase):
    source_workflow: str = Field(..., min_length=1)
    summary: str = Field(..., min_length=1)
    options: list[HandoffOption] = Field(..., min_length=1)
    selected_option: str | None = None
    webui_timeout_seconds: int | None = None


class MenuArtifacts(BaseModel):
    suggested_prompt: str = 'workflow-menu'
    skill_content: str
    source_workflow: str
    received_summary: str
    selected_option: str | None = None
    handoff_options: list[HandoffOption] = Field(default_factory=list)
    menu_session_id: str | None = None
    webui_url: str | None = None
    workflow_state: WorkflowState


class MenuResult(ToolResultBase[MenuArtifacts]):
    artifacts: MenuArtifacts

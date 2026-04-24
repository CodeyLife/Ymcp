from __future__ import annotations

from enum import Enum
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field

from ymcp.core.versioning import SCHEMA_VERSION


class ToolStatus(str, Enum):
    OK = "ok"
    NEEDS_INPUT = "needs_input"
    BLOCKED = "blocked"
    ERROR = "error"


class NextAction(BaseModel):
    label: str
    description: str
    owner: str = "host"


class Risk(BaseModel):
    description: str
    mitigation: str | None = None


class HostActionType(str, Enum):
    DISPLAY_ONLY = "display_only"
    AWAIT_INPUT = "await_input"
    CALL_SELECTED_TOOL = "call_selected_tool"
    CONTINUE_EXECUTION = "continue_execution"
    STOP = "stop"
    FINISH = "finish"


class ResultMeta(BaseModel):
    tool_name: str
    contract: str
    host_controls: list[str] = Field(default_factory=list)
    required_host_action: HostActionType = HostActionType.DISPLAY_ONLY
    safe_to_auto_continue: bool = False
    requires_elicitation: bool = False
    requires_explicit_user_choice: bool = False
    selected_next_tool: str | None = None


ArtifactT = TypeVar("ArtifactT", bound=BaseModel)


class ToolResultBase(BaseModel, Generic[ArtifactT]):
    schema_version: str = SCHEMA_VERSION
    status: ToolStatus
    summary: str
    assumptions: list[str] = Field(default_factory=list)
    next_actions: list[NextAction] = Field(default_factory=list)
    risks: list[Risk] = Field(default_factory=list)
    meta: ResultMeta
    artifacts: ArtifactT

    def to_mcp_result(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


class WorkflowRequestBase(BaseModel):
    schema_version: str = SCHEMA_VERSION

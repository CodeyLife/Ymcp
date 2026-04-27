from __future__ import annotations

from enum import Enum
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field
from pydantic import computed_field
from pydantic import model_validator

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
    STOP = "stop"
    FINISH = "finish"


class ElicitationState(str, Enum):
    NOT_APPLICABLE = "not_applicable"
    ACCEPTED = "accepted"
    DECLINED = "declined"
    CANCELLED = "cancelled"
    UNSUPPORTED = "unsupported"
    FAILED = "failed"


class HandoffOption(BaseModel):
    value: str
    title: str
    description: str
    recommended: bool = False


class Handoff(BaseModel):
    recommended_next_action: str | None = None
    options: list[HandoffOption] = Field(default_factory=list)

    @computed_field(return_type=list[str])
    @property
    def allowed_next_actions(self) -> list[str]:
        return [item.value for item in self.options]

    @model_validator(mode="after")
    def validate_handoff(self) -> "Handoff":
        if self.recommended_next_action and self.recommended_next_action not in set(self.allowed_next_actions):
            raise ValueError("recommended_next_action must be included in options[*].value")
        return self


class ArtifactRef(BaseModel):
    ref: str
    kind: str
    summary: str | None = None


class ResultMeta(BaseModel):
    tool_name: str
    contract: str
    host_controls: list[str] = Field(default_factory=list)
    required_host_action: HostActionType = HostActionType.DISPLAY_ONLY
    handoff: Handoff | None = None
    elicitation_required: bool = False
    elicitation_state: ElicitationState = ElicitationState.NOT_APPLICABLE
    elicitation_selected_option: str | None = None


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

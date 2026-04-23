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


class ResultMeta(BaseModel):
    tool_name: str
    contract: str
    host_controls: list[str] = Field(default_factory=list)


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

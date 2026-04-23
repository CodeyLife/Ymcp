from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase

DEFAULT_MEMORY_WING = "personal"
DEFAULT_MEMORY_ROOM = "ymcp"


class MemoryScope(BaseModel):
    wing: str = DEFAULT_MEMORY_WING
    room: str = DEFAULT_MEMORY_ROOM


class MemoryStoreRequest(WorkflowRequestBase):
    content: str = Field(..., min_length=1)
    wing: str = DEFAULT_MEMORY_WING
    room: str = DEFAULT_MEMORY_ROOM
    source_file: str | None = None
    added_by: str = "ymcp"


class MemorySearchRequest(WorkflowRequestBase):
    query: str = Field(..., min_length=1)
    limit: int = Field(default=5, ge=1, le=50)
    wing: str | None = DEFAULT_MEMORY_WING
    room: str | None = None
    max_distance: float = 1.5
    min_similarity: float | None = None
    context: str | None = None


class MemoryDrawerIdRequest(WorkflowRequestBase):
    drawer_id: str = Field(..., min_length=1)


class MemoryUpdateRequest(WorkflowRequestBase):
    drawer_id: str = Field(..., min_length=1)
    content: str | None = None
    wing: str | None = None
    room: str | None = None


class MemoryListRoomsRequest(WorkflowRequestBase):
    wing: str | None = DEFAULT_MEMORY_WING


class MemoryDuplicateRequest(WorkflowRequestBase):
    content: str = Field(..., min_length=1)
    wing: str = DEFAULT_MEMORY_WING
    room: str = DEFAULT_MEMORY_ROOM


class MemoryNoArgsRequest(WorkflowRequestBase):
    pass


class MemoryGraphQueryRequest(WorkflowRequestBase):
    query: str = Field(..., min_length=1)
    limit: int = Field(default=10, ge=1, le=100)


class MemoryGraphTraverseRequest(WorkflowRequestBase):
    start: str = Field(..., min_length=1)
    depth: int = Field(default=2, ge=1, le=5)


class MemoryKgAddRequest(WorkflowRequestBase):
    subject: str = Field(..., min_length=1)
    predicate: str = Field(..., min_length=1)
    object: str = Field(..., min_length=1)
    source: str | None = "ymcp"


class MemoryTunnelCreateRequest(WorkflowRequestBase):
    source: str = Field(..., min_length=1)
    target: str = Field(..., min_length=1)
    relationship: str | None = None


class MemoryTunnelFindRequest(WorkflowRequestBase):
    query: str = Field(..., min_length=1)
    limit: int = Field(default=10, ge=1, le=100)


class MemoryTunnelFollowRequest(WorkflowRequestBase):
    start: str = Field(..., min_length=1)
    depth: int = Field(default=2, ge=1, le=5)


class MemoryTunnelDeleteRequest(WorkflowRequestBase):
    tunnel_id: str = Field(..., min_length=1)


class MemoryDiaryWriteRequest(WorkflowRequestBase):
    entry: str = Field(..., min_length=1)
    date: str | None = None


class MemoryDiaryReadRequest(WorkflowRequestBase):
    date: str | None = None
    limit: int = Field(default=10, ge=1, le=100)


class MemoryArtifacts(BaseModel):
    operation: str
    wing: str | None = DEFAULT_MEMORY_WING
    room: str | None = DEFAULT_MEMORY_ROOM
    count: int = 0
    items: list[dict[str, Any]] = Field(default_factory=list)
    message: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class MemoryResult(ToolResultBase[MemoryArtifacts]):
    artifacts: MemoryArtifacts

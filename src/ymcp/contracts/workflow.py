from __future__ import annotations

from pydantic import BaseModel, Field


MEMORY_PROTOCOL_STEPS = [
    "回答人物、项目、历史事件、过往决策或其他过去事实前，先调用 mempalace_search、mempalace_get_drawer 或相关图谱工具核验。",
    "如果对事实没有把握，应先明确说明需要查询记忆，再调用相关工具，禁止直接猜测。",
    "任务或会话结束后，将稳定偏好、项目约定、重要决策和踩坑结论写入 mempalace_add_drawer 或 mempalace_diary_write。",
    "当已保存事实发生变化时，用 mempalace_update_drawer、mempalace_delete_drawer、mempalace_kg_invalidate 和 mempalace_kg_add 维护一致性。",
]


class MemoryPreflight(BaseModel):
    required: bool = False
    reason: str | None = None
    query: str | None = None
    suggested_tool: str = "mempalace_search"
    already_satisfied: bool = False
    search_performed: bool = False
    retrieved_count: int = 0
    retrieved_context: list[str] = Field(default_factory=list)


class MemoryContext(BaseModel):
    searched: bool = False
    hits: list[str] = Field(default_factory=list)
    failed: bool = False
    query: str | None = None


class WorkflowPhaseSummary(BaseModel):
    title: str
    summary: str
    highlights: list[str] = Field(default_factory=list)


class WorkflowState(BaseModel):
    workflow_name: str
    current_phase: str
    readiness: str
    evidence_gaps: list[str] = Field(default_factory=list)
    blocked_reason: str | None = None
    memory_preflight: MemoryPreflight | None = None
    current_focus: str | None = None

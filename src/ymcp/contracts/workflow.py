from __future__ import annotations

from pydantic import BaseModel, Field


MEMORY_PROTOCOL_STEPS = [
    "唤醒、恢复上下文或开始长期记忆工作流时，先调用 memory_status 查看记忆库概览。",
    "回答人物、项目、历史事件、过往决策或其他过去事实前，先调用 memory_search、memory_get 或相关图谱工具核验。",
    "如果对事实没有把握，应先明确说明需要查询记忆，再调用相关工具，禁止直接猜测。",
    "任务或会话结束后，将稳定偏好、项目约定、重要决策和踩坑结论写入 memory_store 或 memory_diary_write。",
    "当已保存事实发生变化时，用 memory_update、memory_delete、memory_kg_invalidate 和 memory_kg_add 维护一致性。",
]


def default_memory_protocol() -> list[str]:
    return list(MEMORY_PROTOCOL_STEPS)


class MemoryPreflight(BaseModel):
    required: bool = False
    reason: str | None = None
    query: str | None = None
    suggested_tool: str = "memory_search"
    already_satisfied: bool = False
    search_performed: bool = False
    retrieved_count: int = 0
    retrieved_context: list[str] = Field(default_factory=list)


class MemoryContext(BaseModel):
    searched: bool = False
    hits: list[str] = Field(default_factory=list)
    failed: bool = False
    query: str | None = None


class WorkflowChoiceOption(BaseModel):
    id: str
    label: str
    description: str
    tool: str
    recommended: bool = False
    requires_user_selection: bool = True


class WorkflowState(BaseModel):
    workflow_name: str
    current_phase: str
    readiness: str
    evidence_gaps: list[str] = Field(default_factory=list)
    blocked_reason: str | None = None
    skill_source: str
    memory_protocol_summary: str | None = "先核验记忆，再作答；先维护旧事实，再沉淀新事实。"
    memory_protocol: list[str] = Field(default_factory=default_memory_protocol)
    memory_preflight: MemoryPreflight | None = None

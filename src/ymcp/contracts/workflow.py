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


class ClarityScore(BaseModel):
    dimension: str
    score: float = Field(ge=0.0, le=1.0)
    justification: str
    gap: str


class ReadinessGates(BaseModel):
    non_goals_resolved: bool = False
    decision_boundaries_resolved: bool = False
    pressure_pass_complete: bool = False


class HandoffContract(BaseModel):
    tool: str
    input_artifact: str
    consumer_expectations: list[str] = Field(default_factory=list)
    already_satisfied_stages: list[str] = Field(default_factory=list)
    residual_risk: list[str] = Field(default_factory=list)


class QualityCheck(BaseModel):
    name: str
    passed: bool
    detail: str


class OptionSummary(BaseModel):
    name: str
    summary: str
    pros: list[str] = Field(default_factory=list)
    cons: list[str] = Field(default_factory=list)


class ADRSection(BaseModel):
    decision: str
    drivers: list[str] = Field(default_factory=list)
    alternatives_considered: list[str] = Field(default_factory=list)
    why_chosen: str
    consequences: list[str] = Field(default_factory=list)
    follow_ups: list[str] = Field(default_factory=list)


class CompletionGate(BaseModel):
    name: str
    satisfied: bool
    detail: str


class HandoffGuidance(BaseModel):
    summary_to_pass: str
    constraints_to_preserve: list[str] = Field(default_factory=list)
    expected_verification_evidence: list[str] = Field(default_factory=list)


class WorkflowState(BaseModel):
    workflow_name: str
    current_phase: str
    readiness: str
    evidence_gaps: list[str] = Field(default_factory=list)
    blocked_reason: str | None = None
    memory_preflight: MemoryPreflight | None = None
    current_focus: str | None = None

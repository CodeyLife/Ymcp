from __future__ import annotations

from typing import Any, Literal

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


class WorkflowState(BaseModel):
    workflow_name: str
    current_phase: str
    readiness: str
    host_next_action: str
    host_action_type: Literal["ask_user", "show_options", "call_tool", "collect_evidence", "revise_plan", "run_host_execution", "report_completion"] = "run_host_execution"
    required_host_inputs: list[str] = Field(default_factory=list)
    handoff_target: str | None = None
    handoff_contract: str | None = None
    evidence_gaps: list[str] = Field(default_factory=list)
    blocked_reason: str | None = None
    skill_source: str
    memory_protocol_summary: str | None = "先核验记忆，再作答；先维护旧事实，再沉淀新事实。"
    memory_protocol: list[str] = Field(default_factory=default_memory_protocol)
    memory_preflight: MemoryPreflight | None = None


class HandoffContract(BaseModel):
    target_tool: str
    invocation_summary: str
    required_inputs: list[str] = Field(default_factory=list)
    constraints_to_preserve: list[str] = Field(default_factory=list)



class HandoffOption(BaseModel):
    label: str
    tool: str | None = None
    description: str
    payload_hint: dict[str, str | list[str] | bool | None] = Field(default_factory=dict)


class ToolCallTemplate(BaseModel):
    tool: str
    purpose: str
    arguments: dict[str, str | list[str] | bool | int | float | None] = Field(default_factory=dict)


class ContinuationContract(BaseModel):
    interaction_mode: str
    continuation_required: bool = True
    continuation_kind: Literal[
        "user_answer",
        "review_input",
        "handoff_to_tool",
        "select_handoff_option",
        "select_completion_option",
        "host_execution",
        "provide_evidence",
        "fix_failures",
        "next_phase",
        "user_clarification",
    ]
    continuation_payload: dict[str, str | list[str] | bool | None] = Field(default_factory=dict)
    recommended_user_message: str | None = None
    recommended_host_action: str
    handoff_options: list[HandoffOption] = Field(default_factory=list)
    tool_call_templates: list[ToolCallTemplate] = Field(default_factory=list)
    default_option: str | None = None
    selection_required: bool = False
    option_prompt: str | None = None

    def model_post_init(self, __context: Any) -> None:
        if self.selection_required and not self.continuation_required:
            raise ValueError("selection_required=true 时 continuation_required 必须为 true")
        if self.selection_required and not self.recommended_user_message:
            raise ValueError("selection_required=true 时必须提供 recommended_user_message")

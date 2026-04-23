from __future__ import annotations

from pydantic import BaseModel, Field


class MemoryPreflight(BaseModel):
    required: bool = False
    reason: str | None = None
    query: str | None = None
    suggested_tool: str = "memory_search"
    already_satisfied: bool = False


class WorkflowState(BaseModel):
    workflow_name: str
    current_phase: str
    readiness: str
    host_next_action: str
    required_host_inputs: list[str] = Field(default_factory=list)
    handoff_target: str | None = None
    handoff_contract: str | None = None
    evidence_gaps: list[str] = Field(default_factory=list)
    blocked_reason: str | None = None
    skill_source: str
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


class ContinuationContract(BaseModel):
    interaction_mode: str
    continuation_required: bool = True
    continuation_kind: str
    continuation_payload: dict[str, str | list[str] | bool | None] = Field(default_factory=dict)
    recommended_user_message: str | None = None
    recommended_host_action: str
    handoff_options: list[HandoffOption] = Field(default_factory=list)
    default_option: str | None = None
    selection_required: bool = False
    option_prompt: str | None = None

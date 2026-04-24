from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import MemoryContext, WorkflowChoiceOption, WorkflowState


class RalplanRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    constraints: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)
    deliberate: bool = False
    interactive: bool = False
    current_phase: str = Field(default="planner_draft")
    planner_draft: str | None = None
    architect_feedback: list[str] = Field(default_factory=list)
    critic_feedback: list[str] = Field(default_factory=list)
    critic_verdict_input: str | None = None
    iteration: int = Field(default=1, ge=1, le=12)


class ViableOption(BaseModel):
    name: str
    pros: list[str]
    cons: list[str]


class AdrDraft(BaseModel):
    decision: str
    drivers: list[str]
    alternatives_considered: list[str]
    consequences: list[str]
    follow_ups: list[str]


class RolePromptRef(BaseModel):
    name: str
    arguments: dict[str, str | bool | list[str] | None] = Field(default_factory=dict)


class RalplanArtifacts(BaseModel):
    principles: list[str]
    decision_drivers: list[str]
    viable_options: list[ViableOption]
    chosen_option: str
    adr: AdrDraft
    test_strategy: list[str]
    planner_prompt_ref: RolePromptRef | None = None
    architect_review_prompt: str | None = None
    architect_prompt_ref: RolePromptRef | None = None
    critic_review_prompt: str | None = None
    critic_prompt_ref: RolePromptRef | None = None
    revise_instructions: list[str] = Field(default_factory=list)
    workflow_state: WorkflowState
    critic_verdict: str | None = None
    approved_plan_summary: str | None = None
    requested_input: str | None = None
    selected_next_tool: str | None = None
    handoff_options: list[WorkflowChoiceOption] = Field(default_factory=list)


class RalplanResult(ToolResultBase[RalplanArtifacts]):
    artifacts: RalplanArtifacts

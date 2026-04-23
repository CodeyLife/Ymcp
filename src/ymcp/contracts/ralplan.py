from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import ContinuationContract, HandoffContract, MemoryContext, WorkflowState


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


class RalplanArtifacts(BaseModel):
    principles: list[str]
    decision_drivers: list[str]
    viable_options: list[ViableOption]
    chosen_option: str
    adr: AdrDraft
    test_strategy: list[str]
    architect_review_prompt: str | None = None
    critic_review_prompt: str | None = None
    revise_instructions: list[str] = Field(default_factory=list)
    workflow_state: WorkflowState
    continuation: ContinuationContract
    critic_verdict: str | None = None
    handoff_contract: HandoffContract | None = None


class RalplanResult(ToolResultBase[RalplanArtifacts]):
    artifacts: RalplanArtifacts

from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase


class RalplanRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    constraints: list[str] = Field(default_factory=list)
    deliberate: bool = False


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


class RalplanResult(ToolResultBase[RalplanArtifacts]):
    artifacts: RalplanArtifacts

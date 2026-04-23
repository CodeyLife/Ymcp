from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase


class PlanRequest(WorkflowRequestBase):
    problem: str = Field(..., min_length=1)
    constraints: list[str] = Field(default_factory=list)
    desired_outcome: str | None = None


class PlanArtifacts(BaseModel):
    plan_steps: list[str]
    acceptance_criteria: list[str]
    open_questions: list[str]


class PlanResult(ToolResultBase[PlanArtifacts]):
    artifacts: PlanArtifacts

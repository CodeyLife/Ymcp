from pydantic import BaseModel, Field

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import ContinuationContract, WorkflowState


class PlanRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    mode: str = Field(default="auto")
    constraints: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    review_target: str | None = None
    desired_outcome: str | None = None


class PlanArtifacts(BaseModel):
    requirements_summary: list[str]
    implementation_steps: list[str]
    acceptance_criteria: list[str]
    risks_and_mitigations: list[str]
    verification_steps: list[str]
    evidence_gaps: list[str] = Field(default_factory=list)
    workflow_state: WorkflowState
    continuation: ContinuationContract
    recommended_next_tool: str | None = None
    review_verdict: str | None = None


class PlanResult(ToolResultBase[PlanArtifacts]):
    artifacts: PlanArtifacts

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from ymcp.contracts.common import HandoffOption, ToolResultBase, WorkflowRequestBase
from ymcp.contracts.workflow import MemoryContext, WorkflowState


class QualityCheck(BaseModel):
    name: str
    passed: bool
    detail: str


class CompletionGate(BaseModel):
    name: str
    satisfied: bool
    detail: str


class WorkflowCheckpointRequest(WorkflowRequestBase):
    checkpoint_type: Literal['clarify', 'plan', 'consensus', 'execution']
    task: str = Field(..., min_length=1)
    artifact_summary: str = Field(..., min_length=1)
    acceptance_criteria: list[str] = Field(default_factory=list)
    known_context: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    outstanding_questions: list[str] = Field(default_factory=list)
    memory_context: MemoryContext = Field(default_factory=MemoryContext)
    artifact_payload: dict[str, Any] = Field(default_factory=dict)


class ChoiceOption(HandoffOption):
    pass


class UserChoiceCheckpointRequest(WorkflowRequestBase):
    stage: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    options: list[ChoiceOption] = Field(..., min_length=1)
    selected_option: str | None = None
    context_notes: list[str] = Field(default_factory=list)


class VerificationCheckpointRequest(WorkflowRequestBase):
    task: str = Field(..., min_length=1)
    implementation_summary: str | None = None
    latest_evidence: list[str] = Field(default_factory=list)
    verification_commands: list[str] = Field(default_factory=list)
    verification_results: list[str] = Field(default_factory=list)
    known_failures: list[str] = Field(default_factory=list)
    regression_status: str | None = None
    release_notes_ready: bool = False


class WorkflowCheckpointArtifacts(BaseModel):
    checkpoint_type: str
    verdict: str
    quality_checks: list[QualityCheck] = Field(default_factory=list)
    recommended_next_steps: list[str] = Field(default_factory=list)
    workflow_state: WorkflowState


class UserChoiceCheckpointArtifacts(BaseModel):
    stage: str
    prompt: str
    options: list[ChoiceOption] = Field(default_factory=list)
    selected_option: str | None = None
    workflow_state: WorkflowState


class VerificationCheckpointArtifacts(BaseModel):
    verdict: str
    completion_gates: list[CompletionGate] = Field(default_factory=list)
    missing_evidence: list[str] = Field(default_factory=list)
    recommended_next_steps: list[str] = Field(default_factory=list)
    workflow_state: WorkflowState


class WorkflowCheckpointResult(ToolResultBase[WorkflowCheckpointArtifacts]):
    artifacts: WorkflowCheckpointArtifacts


class UserChoiceCheckpointResult(ToolResultBase[UserChoiceCheckpointArtifacts]):
    artifacts: UserChoiceCheckpointArtifacts


class VerificationCheckpointResult(ToolResultBase[VerificationCheckpointArtifacts]):
    artifacts: VerificationCheckpointArtifacts

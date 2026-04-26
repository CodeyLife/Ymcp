from __future__ import annotations

from uuid import uuid4

from ymcp.contracts.common import ArtifactRef, Handoff, HandoffOption, HostActionType, NextAction, ResultMeta, Risk


HOST_CONTROLS = [
    "user interaction",
    "looping",
    "state persistence",
    "execution",
    "display",
]


def build_meta(
    tool_name: str,
    contract: str,
    host_controls: list[str] | None = None,
    *,
    required_host_action: HostActionType = HostActionType.DISPLAY_ONLY,
    handoff: Handoff | None = None,
) -> ResultMeta:
    return ResultMeta(
        tool_name=tool_name,
        contract=contract,
        host_controls=host_controls or HOST_CONTROLS,
        required_host_action=required_host_action,
        handoff=handoff,
    )


def build_next_action(label: str, description: str, owner: str = "host") -> NextAction:
    return NextAction(label=label, description=description, owner=owner)


def build_handoff_option(
    value: str,
    title: str,
    description: str,
    *,
    recommended: bool = False,
) -> HandoffOption:
    return HandoffOption(
        value=value,
        title=title,
        description=description,
        recommended=recommended,
    )


def build_risk(description: str, mitigation: str | None = None) -> Risk:
    return Risk(description=description, mitigation=mitigation)


def build_artifact_ref(kind: str, summary: str | None = None) -> ArtifactRef:
    return ArtifactRef(ref=f"{kind}:{uuid4().hex[:12]}", kind=kind, summary=summary)

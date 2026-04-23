from __future__ import annotations

from ymcp.contracts.common import NextAction, ResultMeta, Risk, ToolStatus


HOST_CONTROLS = [
    "user interaction",
    "looping",
    "state persistence",
    "execution",
    "display",
]


def build_meta(tool_name: str, contract: str, host_controls: list[str] | None = None) -> ResultMeta:
    return ResultMeta(
        tool_name=tool_name,
        contract=contract,
        host_controls=host_controls or HOST_CONTROLS,
    )


def build_next_action(label: str, description: str, owner: str = "host") -> NextAction:
    return NextAction(label=label, description=description, owner=owner)


def build_risk(description: str, mitigation: str | None = None) -> Risk:
    return Risk(description=description, mitigation=mitigation)


def status_for_missing_inputs(has_missing_context: bool) -> ToolStatus:
    return ToolStatus.NEEDS_INPUT if has_missing_context else ToolStatus.OK

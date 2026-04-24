from __future__ import annotations

from ymcp.contracts.common import HostActionType, NextAction, ResultMeta, Risk, ToolStatus


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
    safe_to_auto_continue: bool = False,
    requires_elicitation: bool = False,
    requires_explicit_user_choice: bool = False,
    selected_next_tool: str | None = None,
) -> ResultMeta:
    return ResultMeta(
        tool_name=tool_name,
        contract=contract,
        host_controls=host_controls or HOST_CONTROLS,
        required_host_action=required_host_action,
        safe_to_auto_continue=safe_to_auto_continue,
        requires_elicitation=requires_elicitation,
        requires_explicit_user_choice=requires_explicit_user_choice,
        selected_next_tool=selected_next_tool,
    )


def build_next_action(label: str, description: str, owner: str = "host") -> NextAction:
    return NextAction(label=label, description=description, owner=owner)


def build_risk(description: str, mitigation: str | None = None) -> Risk:
    return Risk(description=description, mitigation=mitigation)


def status_for_missing_inputs(has_missing_context: bool) -> ToolStatus:
    return ToolStatus.NEEDS_INPUT if has_missing_context else ToolStatus.OK


def apply_selected_tool_handoff(result, selected_next_tool: str):
    result.meta.required_host_action = HostActionType.CALL_SELECTED_TOOL
    result.meta.safe_to_auto_continue = True
    result.meta.requires_elicitation = False
    result.meta.requires_explicit_user_choice = False
    result.meta.selected_next_tool = selected_next_tool
    if hasattr(result, "artifacts") and hasattr(result.artifacts, "selected_next_tool"):
        result.artifacts.selected_next_tool = selected_next_tool
    return result

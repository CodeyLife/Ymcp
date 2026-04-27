from __future__ import annotations

from uuid import uuid4

from ymcp.contracts.common import ArtifactRef, Handoff, HandoffOption, HostActionType, NextAction, ResultMeta, Risk
from ymcp.contracts.common import ToolStatus


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


def apply_selected_handoff_option(result, selected_option: str | None):
    if selected_option is None:
        return result

    selected = selected_option.strip()
    options = result.meta.handoff.options if result.meta.handoff else []
    values = {option.value for option in options}
    artifacts = getattr(result, 'artifacts', None)
    workflow_state = getattr(artifacts, 'workflow_state', None)

    if selected in values:
        result.status = ToolStatus.OK
        result.meta.required_host_action = HostActionType.DISPLAY_ONLY
        result.meta.elicitation_selected_option = selected
        if result.meta.handoff:
            result.meta.handoff.recommended_next_action = selected
        if hasattr(artifacts, 'selected_option'):
            artifacts.selected_option = selected
        if workflow_state is not None:
            workflow_state.current_phase = 'selection_confirmed'
            workflow_state.readiness = 'selection_confirmed'
            workflow_state.current_focus = f'selected:{selected}'
            workflow_state.blocked_reason = None
        result.summary = f"{result.summary}\n\n已记录用户选择：`{selected}`。"
        return result

    result.status = ToolStatus.BLOCKED
    result.meta.required_host_action = HostActionType.AWAIT_INPUT
    if hasattr(artifacts, 'selected_option'):
        artifacts.selected_option = None
    if workflow_state is not None:
        workflow_state.current_phase = 'awaiting_user_selection'
        workflow_state.readiness = 'awaiting_user_selection'
        workflow_state.current_focus = 'invalid_selected_option'
        workflow_state.blocked_reason = f'非法选项：{selected}'
    value_list = '、'.join(f'`{value}`' for value in sorted(values))
    result.summary = f"{result.summary}\n\n收到非法 selected_option：`{selected}`。合法选项只能来自 handoff.options：{value_list}。"
    result.next_actions = [
        build_next_action(
            '重新选择合法菜单项',
            '宿主必须以 handoff.options 作为唯一菜单数据源，等待用户选择一个合法 selected_option 后再继续。',
        )
    ]
    return result

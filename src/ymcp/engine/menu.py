from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.complete_copy import with_handoff_menu_requirement
from ymcp.contracts.common import Handoff, HostActionType, ToolStatus
from ymcp.contracts.menu import MenuArtifacts, MenuRequest, MenuResult
from ymcp.contracts.workflow import WorkflowState
from ymcp.core.result import apply_selected_handoff_option, build_meta, build_next_action


def apply_menu_user_input(result: MenuResult, user_input: str | None) -> MenuResult:
    if user_input is None:
        return result

    content = user_input.strip()
    artifacts = result.artifacts
    workflow_state = artifacts.workflow_state

    if content:
        result.status = ToolStatus.OK
        result.meta.required_host_action = HostActionType.DISPLAY_ONLY
        artifacts.user_input = content
        workflow_state.current_phase = 'input_confirmed'
        workflow_state.readiness = 'input_confirmed'
        workflow_state.current_focus = 'user_input_received'
        workflow_state.blocked_reason = None
        result.summary = f"{result.summary}\n\n已记录用户输入：\n{content}"
        return result

    result.status = ToolStatus.BLOCKED
    result.meta.required_host_action = HostActionType.AWAIT_INPUT
    result.meta.elicitation_error = 'user_input 不能为空'
    artifacts.user_input = None
    workflow_state.current_phase = 'awaiting_user_selection'
    workflow_state.readiness = 'awaiting_user_selection'
    workflow_state.current_focus = 'invalid_user_input'
    workflow_state.blocked_reason = 'user_input 不能为空'
    result.summary = f"{result.summary}\n\n收到空白 user_input；请输入非空内容，或选择一个合法 selected_option。"
    result.next_actions = [
        build_next_action(
            '重新提交用户输入或选择菜单项',
            '宿主应等待用户输入非空 user_input，或从 handoff.options 中选择一个合法 selected_option。',
        )
    ]
    return result


def build_menu(request: MenuRequest) -> MenuResult:
    options = list(request.options)
    handoff = Handoff(
        recommended_next_action=next((option.value for option in options if option.recommended), options[0].value),
        options=options,
    )
    result = MenuResult(
        status=ToolStatus.OK,
        summary=with_handoff_menu_requirement(
            f'{request.source_workflow} 阶段已完成：{request.summary.strip()}',
            '下一步必须由统一 menu tool 基于 handoff.options 收集用户选择',
            closing='不得自动选择推荐项或继续下一流程',
        ),
        assumptions=[],
        next_actions=[
            build_next_action(
                'HOST_INTERACTIVE_MENU_REQUIRED',
                '优先使用 MCP Elicitation；若不可用则使用 menu WebUI fallback 收集 selected_option。',
            )
        ],
        risks=[],
        meta=build_meta(
            'menu',
            'ymcp.contracts.menu.MenuResult',
            host_controls=['display', 'MCP Elicitation', 'webui fallback', 'selected_option tool recall'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=handoff,
        ),
        artifacts=MenuArtifacts(
            skill_content=prompt_content('workflow-menu', request.source_workflow),
            source_workflow=request.source_workflow.strip(),
            received_summary=request.summary.strip(),
            selected_option=None,
            user_input=None,
            handoff_options=options,
            workflow_state=WorkflowState(
                workflow_name='menu',
                current_phase='ready_for_handoff',
                readiness='ready_for_handoff',
                evidence_gaps=[],
                current_focus='elicitation_requested',
            ),
        ),
    )
    if request.user_input is not None:
        return apply_menu_user_input(result, request.user_input)
    return apply_selected_handoff_option(result, request.selected_option)

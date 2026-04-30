from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.complete_copy import with_handoff_menu_requirement
from ymcp.contracts.common import Handoff, HostActionType, ToolStatus
from ymcp.contracts.menu import MenuArtifacts, MenuRequest, MenuResult
from ymcp.contracts.workflow import WorkflowState
from ymcp.core.result import apply_selected_handoff_option, build_meta, build_next_action


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
    return apply_selected_handoff_option(result, request.selected_option)

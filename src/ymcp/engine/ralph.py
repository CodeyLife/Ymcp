from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.complete_copy import with_handoff_menu_requirement
from ymcp.contracts.common import Handoff, HostActionType, ToolStatus
from ymcp.contracts.ralph import RalphArtifacts, RalphCompleteArtifacts, RalphCompleteRequest, RalphCompleteResult, RalphRequest, RalphResult
from ymcp.contracts.workflow import WorkflowState
from ymcp.core.result import apply_selected_handoff_option, build_handoff_option, build_meta, build_next_action


def build_ralph(request: RalphRequest) -> RalphResult:
    skill_content = prompt_content('ralph', 'continue from current conversation context')
    handoff = Handoff(
        recommended_next_action='ydo_menu',
        options=[
            build_handoff_option(
                'ydo_menu',
                '进入 ydo_menu',
                '完成执行、修复、验证流程后调用 ydo_menu。',
                recommended=True,
            )
        ],
    )
    return RalphResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请将 skill_content 作为推理指导进入执行阶段：实现、修复并验证。`ydo` 现在不再要求 `approved_plan_artifact` 输入，而是依赖当前调用链上下文继续执行。完成一轮执行与验证后调用 `ydo_menu`。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '按批准方案执行并收集新鲜验证证据；不要把部分进展称为完成。完成后调用 ydo_menu。')],
        risks=[],
        meta=build_meta(
            'ydo',
            'ymcp.contracts.ralph.RalphResult',
            host_controls=['display', 'prompt guidance', 'execution', 'verification'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=handoff,
        ),
        artifacts=RalphArtifacts(
            skill_content=skill_content,
            workflow_state=WorkflowState(
                workflow_name='ydo',
                current_phase='executing',
                readiness='needs_input',
                evidence_gaps=[],
                current_focus='execution_summary',
            ),
        ),
    )


def build_ralph_complete(request: RalphCompleteRequest) -> RalphCompleteResult:
    skill_content = prompt_content('workflow-menu', 'ydo_menu')
    handoff_options = [
        build_handoff_option(
            'finish',
            '结束当前任务',
            '由宿主结束当前流程。',
            recommended=True,
        ),
        build_handoff_option(
            'memory_store',
            '保存结果到记忆',
            '由宿主沉淀稳定经验与结论。',
        ),
        build_handoff_option(
            'yplan',
            '回到 yplan',
            '调用 yplan，基于执行结果重新规划。',
        ),
        build_handoff_option(
            'continue_execution',
            '继续增强',
            '继续由 LLM 执行后续增强或修复。',
        ),
    ]
    handoff = Handoff(
        recommended_next_action='finish',
        options=handoff_options,
    )
    result = RalphCompleteResult(
        status=ToolStatus.OK,
        summary=with_handoff_menu_requirement(
            '执行阶段当前一轮已结束。下一步只能由宿主基于 handoff.options 渲染真实交互控件并收集 selected_option；assistant 不得用自然语言或 markdown 列表代渲染选项。',
            '本阶段是纯收口阶段，不再要求执行摘要输入。',
            closing='不得自动结束或自动继续',
        ),
        assumptions=[],
        next_actions=[build_next_action('下一步', '若验证未完成或仍有失败项，不要选择 finish。只有此阶段才可建议工作流完成。')],
        risks=[],
        meta=build_meta(
            'ydo_menu',
            'ymcp.contracts.ralph.RalphCompleteResult',
            host_controls=['display', 'execution', 'verification', 'MCP Elicitation'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=handoff,
        ),
        artifacts=RalphCompleteArtifacts(
            skill_content=skill_content,
            execution_verdict='complete',
            selected_option=None,
            handoff_options=handoff_options,
            workflow_state=WorkflowState(
                workflow_name='ydo_menu',
                current_phase='ready_for_handoff',
                readiness='ready_for_handoff',
                evidence_gaps=[],
                current_focus='elicitation_requested',
            ),
        ),
    )
    return apply_selected_handoff_option(result, request.selected_option)

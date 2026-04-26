from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.contracts.common import Handoff, HostActionType, ToolStatus
from ymcp.contracts.ralph import RalphArtifacts, RalphCompleteArtifacts, RalphCompleteRequest, RalphCompleteResult, RalphRequest, RalphResult
from ymcp.contracts.workflow import WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_handoff_option, build_meta, build_next_action


def build_ralph(request: RalphRequest) -> RalphResult:
    skill_content = prompt_content('ralph', 'continue from current conversation context')
    handoff = Handoff(
        recommended_next_action='ydo_complete',
        options=[
            build_handoff_option(
                'ydo_complete',
                '进入 ydo_complete',
                '完成执行、修复、验证流程后调用 ydo_complete。',
                recommended=True,
            )
        ],
    )
    return RalphResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请将 skill_content 作为推理指导进入执行阶段：实现、修复并验证。`ydo` 现在不再要求 `approved_plan_artifact` 输入，而是依赖当前调用链上下文继续执行。完成一轮执行与验证后调用 `ydo_complete`。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '按批准方案执行并收集新鲜验证证据；不要把部分进展称为完成。完成后调用 ydo_complete。')],
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
            phase_summary=WorkflowPhaseSummary(
                title='Ralph Start',
                summary='tool 只返回执行阶段所需的 skill_content 与下一步 handoff。',
                highlights=['suggested_prompt=ralph', 'handoff=ydo_complete', 'input=none'],
            ),
        ),
    )


def build_ralph_complete(request: RalphCompleteRequest) -> RalphCompleteResult:
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
    return RalphCompleteResult(
        status=ToolStatus.OK,
        summary='执行阶段当前一轮已结束。若验证充分且没有未解决问题，选择 `finish` 结束流程；若要沉淀结论，选择 `memory_store`；若执行暴露出新需求或方案失配，选择 `yplan` 重新规划；若还要继续实现或补验证，选择 `continue_execution`。本阶段是纯收口阶段，不再要求执行摘要输入。现在必须通过 Elicitation 向用户展示这些菜单选项，并等待用户选择；不要自动结束或自动继续。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '若验证未完成或仍有失败项，不要选择 finish。只有此阶段才可建议工作流完成。')],
        risks=[],
        meta=build_meta(
            'ydo_complete',
            'ymcp.contracts.ralph.RalphCompleteResult',
            host_controls=['display', 'execution', 'verification', 'MCP Elicitation'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=handoff,
        ),
        artifacts=RalphCompleteArtifacts(
            execution_verdict='complete',
            selected_option=None,
            handoff_options=handoff_options,
            workflow_state=WorkflowState(
                workflow_name='ydo_complete',
                current_phase='handoff',
                readiness='ready',
                evidence_gaps=[],
                current_focus='choose_next_action',
            ),
            phase_summary=WorkflowPhaseSummary(
                title='Ralph Complete',
                summary='tool 在执行收口时只提供 handoff 选项，不接管后续流程。',
                highlights=['handoff=finish,memory_store,yplan,continue_execution'],
            ),
        ),
    )

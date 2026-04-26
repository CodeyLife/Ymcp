from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.ralph import RalphArtifacts, RalphCompleteArtifacts, RalphCompleteRequest, RalphCompleteResult, RalphRequest, RalphResult
from ymcp.contracts.workflow import HandoffOption, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action


def build_ralph(request: RalphRequest) -> RalphResult:
    skill_content = prompt_content('ralph', request.approved_plan)
    return RalphResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请阅读并使用返回的 skill_content 完成执行、修复、验证流程；在形成总结文案后，最后必须调用 ydo_complete。 ',
        assumptions=[],
        next_actions=[build_next_action('下一步', '先消费返回的 skill_content 完成执行、修复、验证流程并输出总结文案；最后调用 ydo_complete。')],
        risks=[],
        meta=build_meta(
            'ydo',
            'ymcp.contracts.ralph.RalphResult',
            host_controls=['display', 'prompt guidance', 'execution', 'verification'],
            required_host_action=HostActionType.AWAIT_INPUT,
        ),
        artifacts=RalphArtifacts(
            skill_content=skill_content,
            readiness_verdict='prompt_required',
            workflow_state=WorkflowState(
                workflow_name='ydo',
                current_phase='executing',
                readiness='needs_input',
                evidence_gaps=[],
            ),
            phase_summary=WorkflowPhaseSummary(
                title='Ralph Start',
                summary='tool 负责返回执行阶段所需的 skill_content，并把收口入口固定到 ydo_complete。',
                highlights=['suggested_prompt=ralph', 'completion_tool=ydo_complete'],
            ),
        ),
    )


def build_ralph_complete(request: RalphCompleteRequest) -> RalphCompleteResult:
    handoff_options = [
        HandoffOption(value='finish', title='结束当前任务', description='结束当前流程。', recommended=True),
        HandoffOption(value='memory_store', title='保存结果到记忆', description='沉淀稳定经验与结论。'),
        HandoffOption(value='yplan', title='回到 yplan', description='基于执行结果重新规划。'),
        HandoffOption(value='continue_execution', title='继续增强', description='继续执行后续增强或修复。'),
    ]
    return RalphCompleteResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='执行阶段已结束；现在必须通过 Elicitation 选择下一步。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '调用 ydo_complete 后，必须通过 Elicitation 展示 finish / memory_store / yplan / continue_execution 选项。')],
        risks=[],
        meta=build_meta(
            'ydo_complete',
            'ymcp.contracts.ralph.RalphCompleteResult',
            host_controls=['display', 'MCP Elicitation', 'execution', 'verification'],
            required_host_action=HostActionType.AWAIT_INPUT,
            requires_elicitation=True,
            requires_explicit_user_choice=True,
        ),
        artifacts=RalphCompleteArtifacts(
            received_summary=request.summary.strip(),
            execution_verdict='complete',
            handoff_options=handoff_options,
            workflow_state=WorkflowState(
                workflow_name='ydo_complete',
                current_phase='handoff',
                readiness='needs_user_choice',
                evidence_gaps=[],
            ),
            phase_summary=WorkflowPhaseSummary(
                title='Ralph Complete',
                summary='tool 在 ralph 收口时触发 Elicitation，向用户展示结束、沉淀、回规划或继续增强选项。',
                highlights=['handoff_options=finish,memory_store,yplan,continue_execution'],
            ),
        ),
    )

from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.deep_interview import (
    DeepInterviewArtifacts,
    DeepInterviewCompleteArtifacts,
    DeepInterviewCompleteRequest,
    DeepInterviewCompleteResult,
    DeepInterviewRequest,
    DeepInterviewResult,
)
from ymcp.contracts.workflow import HandoffOption, MemoryPreflight, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action
from ymcp.engine.memory_preflight import analyze_memory_context


def build_deep_interview(request: DeepInterviewRequest) -> DeepInterviewResult:
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(request.known_context, request.memory_context)
    skill_content = prompt_content('deep-interview', request.brief)
    summary = '请先阅读并使用返回的 skill_content 开展完整需求调研；在形成总结文案后，最后必须调用 ydeep_complete，由该 tool 通过 Elicitation 提供下一步 workflow 选项。'
    state = WorkflowState(
        workflow_name='ydeep',
        current_phase='start',
        readiness='needs_input',
        evidence_gaps=[],
        memory_preflight=MemoryPreflight(
            required=not bool(request.known_context),
            reason='需求澄清前建议先读取相关历史记忆。',
            query=request.brief,
            already_satisfied=bool(request.known_context),
            search_performed=search_performed,
            retrieved_count=retrieved_count,
            retrieved_context=retrieved_context,
        ),
    )
    return DeepInterviewResult(
        status=ToolStatus.NEEDS_INPUT,
        summary=summary,
        assumptions=[],
        next_actions=[build_next_action('下一步', '先消费返回的 skill_content 完成完整需求调研并输出总结文案；最后调用 ydeep_complete。')],
        risks=[],
        meta=build_meta(
            'ydeep',
            'ymcp.contracts.deep_interview.DeepInterviewResult',
            host_controls=['display', 'prompt guidance', 'memory lookup'],
            required_host_action=HostActionType.AWAIT_INPUT,
        ),
        artifacts=DeepInterviewArtifacts(
            skill_content=skill_content,
            readiness_verdict='prompt_required',
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(
                title='Deep Interview Start',
                summary='tool 负责返回需求调研所需的 skill_content，并把收口入口固定到 ydeep_complete。',
                highlights=['suggested_prompt=deep-interview', 'completion_tool=ydeep_complete'],
            ),
        ),
    )


def build_deep_interview_complete(request: DeepInterviewCompleteRequest) -> DeepInterviewCompleteResult:
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(request.known_context, request.memory_context)
    handoff_options = [
        HandoffOption(value='yplan', title='进入 yplan', description='进入共识规划与方案收敛。', recommended=True),
        HandoffOption(value='ydo', title='使用 ydo 执行任务', description='基于当前澄清结果直接进入执行。'),
        HandoffOption(value='refine_further', title='继续澄清', description='继续补充边界、约束或验收标准。'),
    ]
    summary = '需求澄清已完成；现在必须通过 Elicitation 选择下一步 workflow。'
    state = WorkflowState(
        workflow_name='ydeep_complete',
        current_phase='handoff',
        readiness='needs_user_choice',
        evidence_gaps=[],
        memory_preflight=MemoryPreflight(
            required=not bool(request.known_context),
            reason='需求澄清前建议先读取相关历史记忆。',
            query=request.brief,
            already_satisfied=bool(request.known_context),
            search_performed=search_performed,
            retrieved_count=retrieved_count,
            retrieved_context=retrieved_context,
        ),
    )
    return DeepInterviewCompleteResult(
        status=ToolStatus.NEEDS_INPUT,
        summary=summary,
        assumptions=[],
        next_actions=[build_next_action('下一步', '调用 ydeep_complete 后，必须通过 Elicitation 展示下一步 workflow 选项。')],
        risks=[],
        meta=build_meta(
            'ydeep_complete',
            'ymcp.contracts.deep_interview.DeepInterviewCompleteResult',
            host_controls=['display', 'MCP Elicitation', 'memory lookup'],
            required_host_action=HostActionType.AWAIT_INPUT,
            requires_elicitation=True,
            requires_explicit_user_choice=True,
        ),
        artifacts=DeepInterviewCompleteArtifacts(
            received_summary=request.summary.strip(),
            readiness_verdict='ready',
            handoff_options=handoff_options,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(
                title='Deep Interview Complete',
                summary='tool 在 deep-interview 调研结束时触发 Elicitation，向用户展示下一步 workflow 选项。',
                highlights=['suggested_prompt=deep-interview', 'elicitation_required=true'],
            ),
        ),
    )

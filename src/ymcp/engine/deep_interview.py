from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.contracts.common import Handoff, HostActionType, ToolStatus
from ymcp.contracts.deep_interview import (
    DeepInterviewArtifacts,
    DeepInterviewCompleteArtifacts,
    DeepInterviewCompleteRequest,
    DeepInterviewCompleteResult,
    DeepInterviewHandoffArtifact,
    DeepInterviewRequest,
    DeepInterviewResult,
)
from ymcp.contracts.workflow import MemoryPreflight, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_artifact_ref, build_handoff_option, build_meta, build_next_action
from ymcp.engine.memory_preflight import analyze_memory_context


def build_deep_interview(request: DeepInterviewRequest) -> DeepInterviewResult:
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(request.known_context, request.memory_context)
    skill_content = prompt_content('deep-interview', request.brief)
    summary = '请将 skill_content 作为推理指导完成需求调研。完成后调用 ydeep_complete；无需回传中间 artifact。'
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
        current_focus='consume_skill_content',
    )
    handoff = Handoff(
        recommended_next_action='ydeep_complete',
        options=[
            build_handoff_option(
                'ydeep_complete',
                '进入 ydeep_complete',
                '完成调研后调用 ydeep_complete。',
                recommended=True,
            )
        ],
    )
    return DeepInterviewResult(
        status=ToolStatus.NEEDS_INPUT,
        summary=summary,
        assumptions=[],
        next_actions=[build_next_action('下一步', '先消费 skill_content 完成需求调研，再调用 ydeep_complete。')],
        risks=[],
        meta=build_meta(
            'ydeep',
            'ymcp.contracts.deep_interview.DeepInterviewResult',
            host_controls=['display', 'prompt guidance', 'memory lookup'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=handoff,
        ),
        artifacts=DeepInterviewArtifacts(
            skill_content=skill_content,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(
                title='Deep Interview Start',
                summary='tool 只返回需求调研阶段的 skill_content 与下一步 handoff。',
                highlights=['suggested_prompt=deep-interview', 'handoff=ydeep_complete'],
            ),
        ),
    )


def build_deep_interview_complete(request: DeepInterviewCompleteRequest) -> DeepInterviewCompleteResult:
    handoff_options = [
        build_handoff_option(
            'yplan',
            '进入 yplan',
            '进入共识规划与方案收敛。',
            recommended=True,
        ),
        build_handoff_option(
            'refine_further',
            '继续澄清',
            '继续由 LLM 深化边界、约束或验收标准。',
        ),
    ]
    summary = '需求澄清已完成。若需求已经足够清晰，选择 `yplan` 进入规划；若仍需补充边界、约束或验收标准，选择 `refine_further` 继续澄清。'
    state = WorkflowState(
        workflow_name='ydeep_complete',
        current_phase='handoff',
        readiness='ready',
        evidence_gaps=[],
        current_focus='choose_next_workflow',
    )
    handoff = Handoff(
        recommended_next_action='yplan',
        options=handoff_options,
    )
    clarified_artifact = DeepInterviewHandoffArtifact(
        artifact_ref=build_artifact_ref('deep-interview-handoff', request.summary.strip()),
        brief=request.brief,
        summary=request.summary.strip(),
        known_context=request.known_context,
        memory_context=request.memory_context,
    )
    return DeepInterviewCompleteResult(
        status=ToolStatus.OK,
        summary=f'{summary} 现在必须通过 Elicitation 向用户展示这些菜单选项，并等待用户选择；不要自动跳过选择阶段。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '若准备进入规划则选择 yplan；若仍需澄清则选择 refine_further。')],
        risks=[],
        meta=build_meta(
            'ydeep_complete',
            'ymcp.contracts.deep_interview.DeepInterviewCompleteResult',
            host_controls=['display', 'memory lookup', 'MCP Elicitation'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=handoff,
        ),
        artifacts=DeepInterviewCompleteArtifacts(
            received_summary=request.summary.strip(),
            clarified_artifact=clarified_artifact,
            selected_option=None,
            handoff_options=handoff_options,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(
                title='Deep Interview Complete',
                summary='tool 在需求澄清收口时提供跨 workflow 交接用的 clarified_artifact 与 handoff 选项。',
                highlights=['handoff=yplan,refine_further', 'artifact=clarified_artifact'],
            ),
        ),
    )

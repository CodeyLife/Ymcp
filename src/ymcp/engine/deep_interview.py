from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.contracts.common import Handoff, HostActionType, ToolStatus
from ymcp.contracts.deep_interview import (
    DeepInterviewArtifacts,
    DeepInterviewRequest,
    DeepInterviewResult,
)
from ymcp.contracts.workflow import MemoryPreflight, WorkflowState
from ymcp.core.result import build_handoff_option, build_meta, build_next_action
from ymcp.engine.memory_preflight import analyze_memory_context


def build_deep_interview(request: DeepInterviewRequest) -> DeepInterviewResult:
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(request.known_context, request.memory_context)
    skill_content = prompt_content('deep-interview', request.brief)
    summary = '请将 skill_content 作为推理指导完成需求调研。完成任务并输出总结文案后，调用统一 `menu` tool，并把下一步选项作为 options 参数传入。'
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
        recommended_next_action='menu',
        options=[
            build_handoff_option(
                'menu',
                '进入 menu',
                '完成调研与总结后调用统一 menu tool，options 应包含 yplan 与 refine_further。',
                recommended=True,
            )
        ],
    )
    return DeepInterviewResult(
        status=ToolStatus.NEEDS_INPUT,
        summary=summary,
        assumptions=[],
        next_actions=[build_next_action('下一步', '先消费 skill_content 完成需求调研并输出总结，再调用 menu。')],
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
        ),
    )

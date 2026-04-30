from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.contracts.common import Handoff, HostActionType, ToolStatus
from ymcp.contracts.ralplan import (
    RalplanArtifacts,
    RalplanRequest,
    RalplanResult,
)
from ymcp.contracts.workflow import MemoryPreflight, WorkflowState
from ymcp.core.result import build_handoff_option, build_meta, build_next_action
from ymcp.engine.memory_preflight import analyze_memory_context


def _memory_preflight(query: str, known_context: list[str], memory_context):
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(known_context, memory_context)
    return MemoryPreflight(
        required=not bool(known_context),
        reason='共识规划前建议读取相关历史决策与项目记忆。',
        query=query,
        already_satisfied=bool(known_context),
        search_performed=search_performed,
        retrieved_count=retrieved_count,
        retrieved_context=retrieved_context,
    )


def build_ralplan(request: RalplanRequest) -> RalplanResult:
    task, known_context, memory_context = request.task.strip(), request.known_context, request.memory_context
    memory_preflight = _memory_preflight(task, known_context, memory_context)
    skill_content = prompt_content('planner', task)
    handoff = Handoff(
        recommended_next_action='menu',
        options=[
            build_handoff_option(
                'menu',
                '进入 menu',
                '完成 planner / architect / critic 全部规划思考并输出总结后，调用统一 menu tool。',
                recommended=True,
            )
        ],
    )
    return RalplanResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请将 skill_content 作为推理指导，在同一 yplan skill 内完成 planner / architect / critic 三段思考；完成任务并输出规划总结后，调用统一 `menu` tool，并把下一步选项作为 options 参数传入。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '完成规划、架构审视、critic 验收与总结后调用 menu；options 应包含 ydo、yplan、memory_store。')],
        risks=[],
        meta=build_meta(
            'yplan',
            'ymcp.contracts.ralplan.RalplanResult',
            host_controls=['display', 'prompt guidance', 'memory lookup'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=handoff,
        ),
        artifacts=RalplanArtifacts(
            skill_content=skill_content,
            workflow_state=WorkflowState(
                workflow_name='yplan',
                current_phase='planning',
                readiness='needs_input',
                evidence_gaps=[],
                memory_preflight=memory_preflight,
                current_focus='plan_summary',
            ),
        ),
    )

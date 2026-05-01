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


def _base_artifacts(
    request: RalplanRequest,
    *,
    skill_content: str,
    current_phase: str,
    readiness: str,
    current_focus: str,
    blocked_reason: str | None = None,
    memory_preflight: MemoryPreflight | None = None,
) -> RalplanArtifacts:
    return RalplanArtifacts(
        skill_content=skill_content,
        phase=request.phase,
        planner_summary=request.planner_summary,
        architect_summary=request.architect_summary,
        critic_verdict=request.critic_verdict,
        critic_summary=request.critic_summary,
        workflow_state=WorkflowState(
            workflow_name='yplan',
            current_phase=current_phase,
            readiness=readiness,
            evidence_gaps=[],
            memory_preflight=memory_preflight,
            current_focus=current_focus,
            blocked_reason=blocked_reason,
        ),
    )


def _menu_handoff(*, recommended: str = 'menu') -> Handoff:
    return Handoff(
        recommended_next_action=recommended,
        options=[
            build_handoff_option(
                'menu',
                '进入 menu',
                '完成 planner / architect / critic 阶段总结并输出规划总结后，调用统一 menu tool。',
                recommended=recommended == 'menu',
            )
        ],
    )


def _continuation_request(
    *,
    required_next_phase: str,
    missing_field: str | None = None,
    replan_reason: str | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        'workflow_complete': False,
        'terminal': False,
        'must_continue': True,
        'required_next_tool': 'yplan',
        'required_next_phase': required_next_phase,
    }
    if missing_field:
        payload['missing_field'] = missing_field
    if replan_reason:
        payload['replan_reason'] = replan_reason
    return payload


def _blocked_result(request: RalplanRequest, *, reason: str, required_summary: str, next_phase: str) -> RalplanResult:
    result = RalplanResult(
        status=ToolStatus.BLOCKED,
        summary=(
            'WORKFLOW_NOT_COMPLETE: '
            f'{reason} 不得向用户宣布任务完成；必须补齐该字段后继续调用 yplan。'
        ),
        assumptions=[],
        next_actions=[
            build_next_action(
                '补齐 yplan 阶段输入',
                f'先生成并回传 {required_summary}，再调用 yplan phase="{next_phase}"。当前 workflow_complete=false。',
            )
        ],
        risks=[],
        meta=build_meta(
            'yplan',
            'ymcp.contracts.ralplan.RalplanResult',
            host_controls=['display', 'prompt guidance', 'phase gate'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=None,
        ),
        artifacts=_base_artifacts(
            request,
            skill_content=prompt_content('plan', request.task),
            current_phase=request.phase,
            readiness='blocked',
            current_focus='missing_required_summary',
            blocked_reason=required_summary,
        ),
    )
    result.meta.ui_request = _continuation_request(
        required_next_phase=next_phase,
        missing_field=required_summary,
    )
    return result


def _validated(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def build_ralplan(request: RalplanRequest) -> RalplanResult:
    task, known_context, memory_context = request.task.strip(), request.known_context, request.memory_context
    memory_preflight = _memory_preflight(task, known_context, memory_context)
    skill_content = prompt_content('plan', task)

    if request.phase == 'start':
        result = RalplanResult(
            status=ToolStatus.NEEDS_INPUT,
            summary='WORKFLOW_NOT_COMPLETE: 请将 skill_content 作为完整 plan 推理指导，按 yplan phase 顺序提交 planner / architect / critic 阶段总结；先输出 planner_summary，再调用 yplan phase="planner"。',
            assumptions=[],
            next_actions=[build_next_action('下一步', '输出 planner_summary 后调用 yplan phase="planner"；不要跳过 architect / critic，也不要直接调用 menu。当前 workflow_complete=false。')],
            risks=[],
            meta=build_meta(
                'yplan',
                'ymcp.contracts.ralplan.RalplanResult',
                host_controls=['display', 'prompt guidance', 'memory lookup', 'phase gate'],
                required_host_action=HostActionType.AWAIT_INPUT,
                handoff=None,
            ),
            artifacts=_base_artifacts(
                request,
                skill_content=skill_content,
                current_phase='start',
                readiness='needs_planner_summary',
                current_focus='planner_summary',
                memory_preflight=memory_preflight,
            ),
        )
        result.meta.ui_request = _continuation_request(required_next_phase='planner')
        return result

    if request.phase == 'planner':
        if not _validated(request.planner_summary):
            return _blocked_result(
                request,
                reason='yplan phase="planner" 需要非空 planner_summary；不能空参进入 architect 阶段。',
                required_summary='planner_summary',
                next_phase='planner',
            )
        result = RalplanResult(
            status=ToolStatus.NEEDS_INPUT,
            summary='WORKFLOW_NOT_COMPLETE: Planner 阶段总结已记录。下一步必须基于 planner_summary 生成 Architect 审查总结，并调用 yplan phase="architect" 回传 architect_summary。',
            assumptions=[],
            next_actions=[build_next_action('下一步', '生成 Architect 可见总结，输出 architect_summary 后调用 yplan phase="architect"。当前 workflow_complete=false。')],
            risks=[],
            meta=build_meta(
                'yplan',
                'ymcp.contracts.ralplan.RalplanResult',
                host_controls=['display', 'prompt guidance', 'phase gate'],
                required_host_action=HostActionType.AWAIT_INPUT,
                handoff=None,
            ),
            artifacts=_base_artifacts(
                request,
                skill_content=prompt_content('architect', task),
                current_phase='planner',
                readiness='needs_architect_summary',
                current_focus='architect_summary',
            ),
        )
        result.meta.ui_request = _continuation_request(required_next_phase='architect')
        return result

    if request.phase == 'architect':
        if not _validated(request.planner_summary):
            return _blocked_result(
                request,
                reason='yplan phase="architect" 需要先提供 planner_summary；不能跳过 Planner 阶段。',
                required_summary='planner_summary',
                next_phase='planner',
            )
        if not _validated(request.architect_summary):
            return _blocked_result(
                request,
                reason='yplan phase="architect" 需要非空 architect_summary；不能空参进入 Critic 阶段。',
                required_summary='architect_summary',
                next_phase='architect',
            )
        result = RalplanResult(
            status=ToolStatus.NEEDS_INPUT,
            summary='WORKFLOW_NOT_COMPLETE: Architect 阶段总结已记录。下一步必须基于 planner_summary 与 architect_summary 生成 Critic 判定总结，并调用 yplan phase="critic" 回传 critic_verdict 与 critic_summary。',
            assumptions=[],
            next_actions=[build_next_action('下一步', '生成 Critic 可见总结，回传 critic_verdict=APPROVE/ITERATE/REJECT 与 critic_summary。当前 workflow_complete=false。')],
            risks=[],
            meta=build_meta(
                'yplan',
                'ymcp.contracts.ralplan.RalplanResult',
                host_controls=['display', 'prompt guidance', 'phase gate'],
                required_host_action=HostActionType.AWAIT_INPUT,
                handoff=None,
            ),
            artifacts=_base_artifacts(
                request,
                skill_content=prompt_content('critic', task),
                current_phase='architect',
                readiness='needs_critic_verdict',
                current_focus='critic_verdict',
            ),
        )
        result.meta.ui_request = _continuation_request(required_next_phase='critic')
        return result

    if not _validated(request.planner_summary):
        return _blocked_result(
            request,
            reason='yplan phase="critic" 需要先提供 planner_summary；不能跳过 Planner 阶段。',
            required_summary='planner_summary',
            next_phase='planner',
        )
    if not _validated(request.architect_summary):
        return _blocked_result(
            request,
            reason='yplan phase="critic" 需要先提供 architect_summary；不能跳过 Architect 阶段。',
            required_summary='architect_summary',
            next_phase='architect',
        )
    if request.critic_verdict is None:
        return _blocked_result(
            request,
            reason='yplan phase="critic" 需要 critic_verdict=APPROVE/ITERATE/REJECT。',
            required_summary='critic_verdict',
            next_phase='critic',
        )
    if not _validated(request.critic_summary):
        return _blocked_result(
            request,
            reason='yplan phase="critic" 需要非空 critic_summary；不能在没有 Critic 总结时进入 menu。',
            required_summary='critic_summary',
            next_phase='critic',
        )

    if request.critic_verdict != 'APPROVE':
        result = RalplanResult(
            status=ToolStatus.NEEDS_INPUT,
            summary=(
                f'WORKFLOW_NOT_COMPLETE: Critic 判定为 {request.critic_verdict}。'
                '规划尚未批准，ITERATE/REJECT 不是终态，不得进入 menu，不得推荐 ydo，也不得向用户宣布任务完成；'
                '必须将 critic_summary 的修订要求回灌到 Planner，并调用 yplan phase="planner" 提交修订后的 planner_summary。'
            ),
            assumptions=[],
            next_actions=[
                build_next_action(
                    '返回 Planner 修订',
                    '基于 critic_summary 和 architect_summary 修订 planner_summary，然后调用 yplan phase="planner"。当前 workflow_complete=false。',
                )
            ],
            risks=[],
            meta=build_meta(
                'yplan',
                'ymcp.contracts.ralplan.RalplanResult',
                host_controls=['display', 'phase gate', 'replan guidance'],
                required_host_action=HostActionType.AWAIT_INPUT,
                handoff=None,
            ),
            artifacts=_base_artifacts(
                request,
                skill_content=prompt_content('plan', task),
                current_phase='critic',
                readiness='replan_required',
                current_focus='planner_summary',
                memory_preflight=memory_preflight,
            ),
        )
        result.meta.ui_request = _continuation_request(
            required_next_phase='planner',
            replan_reason=request.critic_verdict,
        )
        return result

    return RalplanResult(
        status=ToolStatus.OK,
        summary='Critic 已 APPROVE。规划阶段已具备进入 menu 的条件；请先输出可见规划总结，然后调用 menu(source_workflow="yplan", options=[ydo, yplan, memory_store])。',
        assumptions=[],
        next_actions=[build_next_action('调用 menu', '使用当前 planner/architect/critic 总结作为 summary，options 应包含 ydo、yplan、memory_store。')],
        risks=[],
        meta=build_meta(
            'yplan',
            'ymcp.contracts.ralplan.RalplanResult',
            host_controls=['display', 'phase gate', 'menu handoff guidance'],
            required_host_action=HostActionType.DISPLAY_ONLY,
            handoff=_menu_handoff(),
        ),
        artifacts=_base_artifacts(
            request,
            skill_content=prompt_content('workflow-menu', 'yplan'),
            current_phase='critic',
            readiness='ready_for_menu',
            current_focus='menu',
            memory_preflight=memory_preflight,
        ),
    )

from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.ralplan import (
    RalplanArchitectArtifacts,
    RalplanArchitectRequest,
    RalplanArchitectResult,
    RalplanCompleteArtifacts,
    RalplanCompleteRequest,
    RalplanCompleteResult,
    RalplanCriticArtifacts,
    RalplanCriticRequest,
    RalplanCriticResult,
    RalplanArtifacts,
    RalplanRequest,
    RalplanResult,
)
from ymcp.contracts.workflow import HandoffOption, MemoryPreflight, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action
from ymcp.engine.memory_preflight import analyze_memory_context


def _normalize_critic_verdict(value: str) -> str:
    text = (value or '').strip().upper()
    if not text:
        return 'REVISE'
    first_token = text.split()[0]
    if first_token in {'APPROVE', 'REVISE', 'REJECT'}:
        return first_token
    first_line = text.splitlines()[0].strip()
    if first_line in {'APPROVE', 'REVISE', 'REJECT'}:
        return first_line
    return 'REVISE'


def _memory_preflight(query: str, known_context: list[str], memory_context):
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(known_context, memory_context)
    return (
        search_performed,
        retrieved_count,
        retrieved_context,
        MemoryPreflight(
            required=not bool(known_context),
            reason='共识规划前建议读取相关历史决策与项目记忆。',
            query=query,
            already_satisfied=bool(known_context),
            search_performed=search_performed,
            retrieved_count=retrieved_count,
            retrieved_context=retrieved_context,
        ),
    )


def build_ralplan(request: RalplanRequest) -> RalplanResult:
    _, _, _, memory_preflight = _memory_preflight(request.task, request.known_context, request.memory_context)
    skill_content = prompt_content('planner', request.task)
    return RalplanResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请先阅读并使用返回的 skill_content 完成 planner 阶段并输出总结文案；最后必须调用 yplan_architect。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '先消费返回的 skill_content 完成 planner 阶段并输出总结文案；最后调用 yplan_architect。')],
        risks=[],
        meta=build_meta(
            'yplan',
            'ymcp.contracts.ralplan.RalplanResult',
            host_controls=['display', 'prompt guidance', 'memory lookup'],
            required_host_action=HostActionType.AWAIT_INPUT,
        ),
        artifacts=RalplanArtifacts(
            skill_content=skill_content,
            readiness_verdict='prompt_required',
            workflow_state=WorkflowState(
                workflow_name='yplan',
                current_phase='planner',
                readiness='needs_input',
                evidence_gaps=[],
                memory_preflight=memory_preflight,
            ),
            phase_summary=WorkflowPhaseSummary(
                title='Ralplan Planner Start',
                summary='tool 负责返回 planner 阶段所需的 skill_content，并把下一步固定到 yplan_architect。',
                highlights=['suggested_prompt=planner', 'next_tool=yplan_architect'],
            ),
        ),
    )


def build_ralplan_architect(request: RalplanArchitectRequest) -> RalplanArchitectResult:
    _, _, _, memory_preflight = _memory_preflight(request.task, request.known_context, request.memory_context)
    skill_content = prompt_content('architect', request.plan_summary.strip() or request.task)
    return RalplanArchitectResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请阅读并使用返回的 skill_content 完成 architect 阶段并输出总结文案；最后必须调用 yplan_critic。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '先消费返回的 skill_content 完成 architect 阶段并输出总结文案；最后调用 yplan_critic。')],
        risks=[],
        meta=build_meta(
            'yplan_architect',
            'ymcp.contracts.ralplan.RalplanArchitectResult',
            host_controls=['display', 'prompt guidance', 'memory lookup'],
            required_host_action=HostActionType.AWAIT_INPUT,
        ),
        artifacts=RalplanArchitectArtifacts(
            skill_content=skill_content,
            plan_summary=request.plan_summary.strip() or None,
            planner_notes=request.planner_notes,
            readiness_verdict='prompt_required',
            workflow_state=WorkflowState(
                workflow_name='yplan_architect',
                current_phase='architect',
                readiness='needs_input',
                evidence_gaps=[],
                memory_preflight=memory_preflight,
            ),
            phase_summary=WorkflowPhaseSummary(
                title='Ralplan Architect',
                summary='tool 负责返回 architect 阶段所需的 skill_content，并把下一步固定到 yplan_critic。',
                highlights=['suggested_prompt=architect', 'next_tool=yplan_critic'],
            ),
        ),
    )


def build_ralplan_critic(request: RalplanCriticRequest) -> RalplanCriticResult:
    _, _, _, memory_preflight = _memory_preflight(request.task, request.known_context, request.memory_context)
    skill_content = prompt_content('critic', request.plan_summary.strip() or request.task)
    critic_verdict = _normalize_critic_verdict(request.critic_verdict)
    approved = critic_verdict == 'APPROVE'
    return RalplanCriticResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请阅读并使用返回的 skill_content 完成 critic 阶段并输出总结文案；仅当 Critic 判定为 APPROVE 时，最后才允许调用 yplan_complete。' if approved else '当前 Critic 判定为 REVISE；请继续修订方案并输出更新后的总结文案，不要调用 yplan_complete。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '先消费返回的 skill_content 完成 critic 阶段并输出总结文案；若 verdict=APPROVE，再调用 yplan_complete。' if approved else '根据当前 REVISE 结论继续修订方案并重新进入后续评审，不要调用 yplan_complete。')],
        risks=[],
        meta=build_meta(
            'yplan_critic',
            'ymcp.contracts.ralplan.RalplanCriticResult',
            host_controls=['display', 'prompt guidance', 'memory lookup'],
            required_host_action=HostActionType.AWAIT_INPUT,
        ),
        artifacts=RalplanCriticArtifacts(
            skill_content=skill_content,
            next_tool='yplan_complete' if approved else None,
            plan_summary=request.plan_summary.strip() or None,
            planner_notes=request.planner_notes,
            architect_notes=request.architect_notes,
            critic_verdict=critic_verdict,
            critic_notes=request.critic_notes,
            acceptance_criteria=request.acceptance_criteria,
            readiness_verdict='approved' if approved else 'needs_revision',
            workflow_state=WorkflowState(
                workflow_name='yplan_critic',
                current_phase='critic',
                readiness='needs_input',
                evidence_gaps=[] if approved else ['critic_verdict=APPROVE required before yplan_complete'],
                blocked_reason=None if approved else 'Critic 判定为 REVISE，需先修订方案。',
                memory_preflight=memory_preflight,
            ),
            phase_summary=WorkflowPhaseSummary(
                title='Ralplan Critic',
                summary='tool 负责返回 critic 阶段所需的 skill_content，并根据 Critic 结论决定是否允许进入 yplan_complete。',
                highlights=['suggested_prompt=critic', f'critic_verdict={critic_verdict}', 'next_tool=yplan_complete' if approved else 'revision_required=true'],
            ),
        ),
    )


def build_ralplan_complete(request: RalplanCompleteRequest) -> RalplanCompleteResult:
    _, _, _, memory_preflight = _memory_preflight(request.task, request.known_context, request.memory_context)
    critic_verdict = _normalize_critic_verdict(request.critic_verdict)
    if critic_verdict != 'APPROVE':
        return RalplanCompleteResult(
            status=ToolStatus.BLOCKED,
            summary='当前 Critic 结论不是 APPROVE，不能进入 yplan_complete；请先继续修订方案。',
            assumptions=[],
            next_actions=[build_next_action('下一步', '根据 Critic 的 REVISE 结论继续修订方案，并在再次获得 APPROVE 后再调用 yplan_complete。')],
            risks=[],
            meta=build_meta(
                'yplan_complete',
                'ymcp.contracts.ralplan.RalplanCompleteResult',
                host_controls=['display', 'memory lookup'],
                required_host_action=HostActionType.STOP,
            ),
            artifacts=RalplanCompleteArtifacts(
                received_summary=request.summary.strip(),
                critic_verdict=critic_verdict,
                consensus_verdict='needs_revision',
                approved_plan_summary=request.plan_summary.strip() or None,
                planner_notes=request.planner_notes,
                architect_notes=request.architect_notes,
                critic_notes=request.critic_notes,
                acceptance_criteria=request.acceptance_criteria,
                handoff_options=[],
                workflow_state=WorkflowState(
                    workflow_name='yplan_complete',
                    current_phase='handoff',
                    readiness='needs_input',
                    evidence_gaps=['critic_verdict=APPROVE required'],
                    blocked_reason='Critic 判定为 REVISE，禁止进入完成态交接。',
                    memory_preflight=memory_preflight,
                ),
                phase_summary=WorkflowPhaseSummary(
                    title='Ralplan Complete Blocked',
                    summary='只有 Critic 判定为 APPROVE 时，yplan_complete 才能触发 Elicitation。',
                    highlights=[f'critic_verdict={critic_verdict}'],
                ),
            ),
        )
    handoff_options = [
        HandoffOption(value='ydo', title='使用 ydo 执行任务', description='按当前批准方案进入执行与验证。', recommended=True),
        HandoffOption(value='restart', title='重新开始规划', description='回到 yplan，从 planner 阶段重开整轮规划。'),
        HandoffOption(value='memory_store', title='保存规划到记忆', description='将当前规划摘要沉淀为长期记忆。'),
    ]
    return RalplanCompleteResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='共识规划已结束；现在必须通过 Elicitation 选择下一步 workflow。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '调用 yplan_complete 后，必须通过 Elicitation 展示 ydo / restart / memory_store 选项。')],
        risks=[],
        meta=build_meta(
            'yplan_complete',
            'ymcp.contracts.ralplan.RalplanCompleteResult',
            host_controls=['display', 'MCP Elicitation', 'memory lookup'],
            required_host_action=HostActionType.AWAIT_INPUT,
            requires_elicitation=True,
            requires_explicit_user_choice=True,
        ),
        artifacts=RalplanCompleteArtifacts(
            received_summary=request.summary.strip(),
            critic_verdict=critic_verdict,
            consensus_verdict='approved',
            approved_plan_summary=request.plan_summary.strip() or None,
            planner_notes=request.planner_notes,
            architect_notes=request.architect_notes,
            critic_notes=request.critic_notes,
            acceptance_criteria=request.acceptance_criteria,
            handoff_options=handoff_options,
            workflow_state=WorkflowState(
                workflow_name='yplan_complete',
                current_phase='handoff',
                readiness='needs_user_choice',
                evidence_gaps=[],
                memory_preflight=memory_preflight,
            ),
            phase_summary=WorkflowPhaseSummary(
                title='Ralplan Complete',
                summary='tool 在 ralplan 收口时触发 Elicitation，向用户展示执行、重开或记忆沉淀选项。',
                highlights=['handoff_options=ydo,restart,memory_store'],
            ),
        ),
    )

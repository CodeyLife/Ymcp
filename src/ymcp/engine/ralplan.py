from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.contracts.common import Handoff, HostActionType, ToolStatus
from ymcp.contracts.ralplan import (
    RalplanArchitectArtifacts,
    RalplanArchitectRequest,
    RalplanArchitectResult,
    RalplanArtifacts,
    RalplanCompleteArtifacts,
    RalplanCompleteRequest,
    RalplanCompleteResult,
    RalplanCriticArtifacts,
    RalplanCriticRequest,
    RalplanCriticResult,
    RalplanRequest,
    RalplanResult,
)
from ymcp.contracts.workflow import MemoryPreflight, WorkflowPhaseSummary, WorkflowState
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
        recommended_next_action='yplan_architect',
        options=[
            build_handoff_option(
                'yplan_architect',
                '进入 yplan_architect',
                '完成 planner 阶段后调用 yplan_architect。',
                recommended=True,
            )
        ],
    )
    return RalplanResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请将 skill_content 作为推理指导完成 planner 阶段；产出初版方案后调用 `yplan_architect`。当前阶段只有一个合法下一步：进入 architect 阶段。`handoff.options` 由服务端生成，应直接使用，不要自行构造新的选项对象。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '先完成 planner 阶段输出；完成后调用 yplan_architect。不要跳过 architect 阶段直接 complete。')],
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
            phase_summary=WorkflowPhaseSummary(
                title='Plan Start',
                summary='tool 只返回 planner 阶段的 skill_content 与下一步 handoff；workflow_state 仅描述当前阶段，不承担跨阶段状态保存。',
                highlights=['suggested_prompt=planner', 'handoff=yplan_architect', 'workflow_state_is_phase_local=true'],
            ),
        ),
    )


def build_ralplan_architect(request: RalplanArchitectRequest) -> RalplanArchitectResult:
    skill_content = prompt_content('architect')
    handoff = Handoff(
        recommended_next_action='yplan_critic',
        options=[
            build_handoff_option(
                'yplan_critic',
                '进入 yplan_critic',
                '完成 architect 阶段后调用 yplan_critic。',
                recommended=True,
            )
        ],
    )
    return RalplanArchitectResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请将 skill_content 作为推理指导完成 architect 阶段；补强边界、接口与风险后调用 `yplan_critic`。当前阶段只有一个合法下一步：进入 critic 阶段。`handoff.options` 由服务端生成，应直接使用，不要自行构造新的选项对象。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '完成 architect 阶段后调用 yplan_critic。')],
        risks=[],
        meta=build_meta(
            'yplan_architect',
            'ymcp.contracts.ralplan.RalplanArchitectResult',
            host_controls=['display', 'prompt guidance'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=handoff,
        ),
        artifacts=RalplanArchitectArtifacts(
            skill_content=skill_content,
            workflow_state=WorkflowState(
                workflow_name='yplan_architect',
                current_phase='architect',
                readiness='needs_input',
                evidence_gaps=[],
                current_focus='architecture_review',
            ),
            phase_summary=WorkflowPhaseSummary(
                title='Ralplan Architect',
                summary='tool 只返回 architect 阶段的 skill_content 与下一步 handoff；workflow_state 仅描述当前阶段，不承担跨阶段状态保存。',
                highlights=['suggested_prompt=architect', 'handoff=yplan_critic', 'workflow_state_is_phase_local=true'],
            ),
        ),
    )


def build_ralplan_critic(request: RalplanCriticRequest) -> RalplanCriticResult:
    skill_content = prompt_content('critic')
    handoff = Handoff(
        recommended_next_action=None,
        options=[
            build_handoff_option(
                'yplan',
                '返回 yplan 重开规划',
                '若 critic 认为方案仍不可执行，必须回到 yplan 重新开始规划。',
            ),
            build_handoff_option(
                'yplan_complete',
                '进入 yplan_complete',
                '若 critic 认为方案已可执行，则调用 yplan_complete 结束规划并返回下一步菜单；不要把它当成最终分析结论步骤。',
            ),
        ],
    )
    return RalplanCriticResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请将 skill_content 作为推理指导完成 critic 阶段。若你认为方案已经足够清晰、完整且可执行，应明确批准理由，然后立即调用 `yplan_complete` 结束规划并进入下一步菜单；不要在写完批准结论后直接结束当前轮，也不要把 `yplan_complete` 当成最终分析结论步骤。若你认为方案仍不可执行，必须选择 `yplan` 重开规划。不要依赖固定 verdict 协议。`handoff.options` 由服务端生成，应直接使用，不要自行构造新的选项对象。',
        assumptions=[],
        next_actions=[
            build_next_action('方案通过', '若当前方案已足够清晰、完整、可执行，则给出简短批准理由后立即调用 yplan_complete；不要在批准结论后直接结束当前轮，也不要在 complete 阶段期待最终分析结论。'),
            build_next_action('方案驳回', '若仍有缺口或风险，必须回到 yplan 重开规划，不要继续调用 yplan_critic。'),
        ],
        risks=[],
        meta=build_meta(
            'yplan_critic',
            'ymcp.contracts.ralplan.RalplanCriticResult',
            host_controls=['display', 'prompt guidance'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=handoff,
        ),
        artifacts=RalplanCriticArtifacts(
            skill_content=skill_content,
            workflow_state=WorkflowState(
                workflow_name='yplan_critic',
                current_phase='critic',
                readiness='needs_input',
                evidence_gaps=[],
                current_focus='critic_verdict',
            ),
            phase_summary=WorkflowPhaseSummary(
                title='Ralplan Critic',
                summary='tool 只返回 critic 阶段的 skill_content 与合法下一跳白名单；workflow_state 仅描述当前阶段，不承担跨阶段状态保存。',
                highlights=['suggested_prompt=critic', 'handoff=yplan|yplan_complete', 'verdict_protocol=llm_decides', 'workflow_state_is_phase_local=true'],
            ),
        ),
    )


def build_ralplan_complete(request: RalplanCompleteRequest) -> RalplanCompleteResult:
    handoff_options = [
        build_handoff_option(
            'ydo',
            '使用 ydo 执行任务',
            '规划阶段已经结束，直接进入执行与验证阶段。',
            recommended=True,
        ),
        build_handoff_option(
            'restart',
            '重新开始规划',
            '由宿主重启规划流程，并回到 yplan。',
        ),
        build_handoff_option(
            'memory_store',
            '保存规划到记忆',
            '由宿主将当前规划摘要沉淀为长期记忆。',
        ),
    ]
    handoff = Handoff(
        recommended_next_action='ydo',
        options=handoff_options,
    )
    return RalplanCompleteResult(
        status=ToolStatus.OK,
        summary='共识规划已结束。若要开始执行，选择 `ydo` 进入执行阶段；若要从头再规划，选择 `restart`；若只想把当前结论沉淀到记忆，选择 `memory_store`。本阶段是纯收口 / handoff 阶段，不继续分析、不生成最终业务结论，也不自动进入下一流程。宿主现在必须以 `handoff.options` 作为唯一权威菜单数据源，通过 Elicitation 完整展示全部菜单项，并逐项提供标题与描述；不得省略、改写、新增，也不得自动继续。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '读取 handoff.options；通常直接按 recommended_next_action 进入 ydo。不要在此阶段重新展开长篇规划，也不要把 complete 当成最终结论生成步骤。')],
        risks=[],
        meta=build_meta(
            'yplan_complete',
            'ymcp.contracts.ralplan.RalplanCompleteResult',
            host_controls=['display', 'memory lookup', 'MCP Elicitation'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=handoff,
        ),
        artifacts=RalplanCompleteArtifacts(
            selected_option=None,
            handoff_options=handoff_options,
            workflow_state=WorkflowState(
                workflow_name='yplan_complete',
                current_phase='handoff',
                readiness='ready',
                evidence_gaps=[],
                current_focus='choose_next_workflow',
            ),
            phase_summary=WorkflowPhaseSummary(
                title='Ralplan Complete',
                summary='tool 在 ralplan 收口时只提供 handoff 选项，不继续分析，不生成最终业务结论，也不构造中间 artifact；workflow_state 仅描述当前阶段。',
                highlights=['handoff=ydo,restart,memory_store', 'input=none', 'workflow_state_is_phase_local=true'],
            ),
        ),
    )

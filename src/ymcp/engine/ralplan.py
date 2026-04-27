from __future__ import annotations

from ymcp.capabilities import prompt_content
from ymcp.complete_copy import with_handoff_menu_requirement
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
from ymcp.contracts.workflow import MemoryPreflight, WorkflowState
from ymcp.core.result import apply_selected_handoff_option, build_handoff_option, build_meta, build_next_action
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
                '完成 architect 阶段后，必须在同一轮先输出 architecture review 摘要，然后立即调用 yplan_critic 并传入 architect_summary；只输出摘要后停止是协议违规。',
                recommended=True,
            )
        ],
    )
    return RalplanArchitectResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请将 skill_content 作为推理指导完成 architect 阶段；必须先在对话中输出 architecture review 摘要，至少包含架构评估、steelman 反论点、真实 tradeoff、综合建议、风险/证据缺口；然后在同一轮立即调用 `yplan_critic`，并把该摘要作为 `architect_summary` 传入。不要空参调用 yplan_critic。不要在输出 architecture review 摘要后结束当前轮；只输出摘要但不调用 yplan_critic 是协议违规。',
        assumptions=[],
        next_actions=[build_next_action('下一步', '完成 architect 阶段输出后，在同一轮立即调用 yplan_critic，并传入 architect_summary。不要空参进入 critic，也不要在摘要后停止。')],
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
        ),
    )


def build_ralplan_critic(request: RalplanCriticRequest) -> RalplanCriticResult:
    architect_summary = request.architect_summary.strip() if request.architect_summary else None
    if not architect_summary:
        return RalplanCriticResult(
            status=ToolStatus.BLOCKED,
            summary='yplan_critic 不能空参进入。请先完成 yplan_architect 的可见 architecture review 输出，并再次调用 yplan_critic 时传入 architect_summary；该字段应简要包含架构评估、steelman 反论点、tradeoff、综合建议、风险或证据缺口。当前不会进入 critic 判断，也不会继续到 yplan_complete。',
            assumptions=[],
            next_actions=[
                build_next_action(
                    '补充 architect_summary',
                    '回到 architect 阶段输出架构评审摘要；完成后调用 yplan_critic，并传入 architect_summary。',
                )
            ],
            risks=[],
            meta=build_meta(
                'yplan_critic',
                'ymcp.contracts.ralplan.RalplanCriticResult',
                host_controls=['display', 'prompt guidance'],
                required_host_action=HostActionType.AWAIT_INPUT,
                handoff=Handoff(
                    recommended_next_action=None,
                    options=[
                        build_handoff_option(
                            'yplan_architect',
                            '返回 yplan_architect 补充架构评审',
                            '先输出 architecture review 摘要，再携带 architect_summary 调用 yplan_critic。',
                            recommended=True,
                        )
                    ],
                ),
            ),
            artifacts=RalplanCriticArtifacts(
                architect_summary=None,
                skill_content='',
                workflow_state=WorkflowState(
                    workflow_name='yplan_critic',
                    current_phase='architect_summary_required',
                    readiness='needs_input',
                    evidence_gaps=['缺少 architect_summary，无法证明 architect 阶段已完成可见评审输出。'],
                    blocked_reason='architect_summary_required',
                    current_focus='architect_summary_required',
                ),
            ),
        )
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
                '若 critic 认为方案已可执行，先输出 critic 评估与批准摘要，再调用 yplan_complete 并传入 critic_summary；不要空参调用 complete。',
            ),
        ],
    )
    return RalplanCriticResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请将 skill_content 作为推理指导完成 critic 阶段。若你认为方案已经足够清晰、完整且可执行，必须先在对话中输出 critic 评估、批准理由、关键约束、风险与验证摘要；然后才可调用 `yplan_complete`，并必须把该摘要作为 `critic_summary` 传入。不要空参调用 `yplan_complete`，不要把 complete 当成生成最终分析结论的步骤。若你认为方案仍不可执行，必须选择 `yplan` 重开规划。不要依赖固定 verdict 协议。',
        assumptions=[],
        next_actions=[
            build_next_action('方案通过', '若当前方案已足够清晰、完整、可执行，则先输出 critic 评估和批准摘要，再调用 yplan_complete，并传入 critic_summary；不要空参调用 complete。'),
            build_next_action('方案驳回', '若仍有缺口或风险，必须回到 yplan 重开规划'),
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
            architect_summary=architect_summary,
            skill_content=skill_content,
            workflow_state=WorkflowState(
                workflow_name='yplan_critic',
                current_phase='critic',
                readiness='needs_input',
                evidence_gaps=[],
                current_focus='critic_verdict',
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
    critic_summary = request.critic_summary.strip() if request.critic_summary else None
    if not critic_summary and request.selected_option is None:
        return RalplanCompleteResult(
            status=ToolStatus.BLOCKED,
            summary='yplan_complete 不能空参收口。请先完成 yplan_critic 的可见评估输出，并再次调用 yplan_complete 时传入 critic_summary；该字段应简要包含批准理由、关键约束、风险、验收/验证要点。当前不会进入执行菜单，也不会宣称规划已结束。',
            assumptions=[],
            next_actions=[
                build_next_action(
                    '补充 critic_summary',
                    '回到 critic 阶段输出评估与批准摘要；若方案已批准，再调用 yplan_complete，并传入 critic_summary。',
                )
            ],
            risks=[],
            meta=build_meta(
                'yplan_complete',
                'ymcp.contracts.ralplan.RalplanCompleteResult',
                host_controls=['display', 'prompt guidance'],
                required_host_action=HostActionType.AWAIT_INPUT,
                handoff=Handoff(
                    recommended_next_action=None,
                    options=[
                        build_handoff_option(
                            'yplan_critic',
                            '返回 yplan_critic 补充评估',
                            '先输出 critic 评估与批准摘要，再携带 critic_summary 调用 yplan_complete。',
                            recommended=True,
                        )
                    ],
                ),
            ),
            artifacts=RalplanCompleteArtifacts(
                critic_summary=None,
                selected_option=None,
                handoff_options=[],
                workflow_state=WorkflowState(
                    workflow_name='yplan_complete',
                    current_phase='critic_summary_required',
                    readiness='needs_input',
                    evidence_gaps=['缺少 critic_summary，无法证明 critic 阶段已完成可见评估输出。'],
                    blocked_reason='critic_summary_required',
                    current_focus='critic_summary_required',
                ),
            ),
        )
    result = RalplanCompleteResult(
        status=ToolStatus.OK,
        summary=with_handoff_menu_requirement(
            '共识规划已结束。本阶段是纯收口 / handoff 阶段，不继续分析、不生成最终业务结论，也不自动进入下一流程。',
            '下一步只能由宿主基于 handoff.options 渲染真实交互控件并收集 selected_option；assistant 不得用自然语言或 markdown 列表代渲染选项。',
            closing='不得自动继续',
        ),
        assumptions=[],
        next_actions=[build_next_action('HOST_UI_REQUIRED', '宿主读取 handoff.options 渲染真实交互控件并等待 selected_option；assistant 不得输出文本菜单、开放式询问或继续分析。')],
        risks=[],
        meta=build_meta(
            'yplan_complete',
            'ymcp.contracts.ralplan.RalplanCompleteResult',
            host_controls=['display', 'memory lookup', 'MCP Elicitation'],
            required_host_action=HostActionType.AWAIT_INPUT,
            handoff=handoff,
        ),
        artifacts=RalplanCompleteArtifacts(
            critic_summary=critic_summary,
            selected_option=None,
            handoff_options=handoff_options,
            workflow_state=WorkflowState(
                workflow_name='yplan_complete',
                current_phase='ready_for_handoff',
                readiness='ready_for_handoff',
                evidence_gaps=[],
                current_focus='elicitation_requested',
            ),
        ),
    )
    return apply_selected_handoff_option(result, request.selected_option)

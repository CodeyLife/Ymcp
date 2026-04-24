from ymcp.contracts.common import ToolStatus
from ymcp.contracts.ralplan import AdrDraft, RalplanArtifacts, RalplanRequest, RalplanResult, RolePromptRef, ViableOption
from ymcp.contracts.workflow import MemoryPreflight, WorkflowChoiceMenu, WorkflowChoiceOption, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action, build_risk
from ymcp.engine.memory_preflight import analyze_memory_context


def _options(deliberate: bool) -> list[ViableOption]:
    options = [
        ViableOption(name="状态机投影", pros=["更适合结构化交接", "更贴近 MCP 标准实践"], cons=["需要保持协议与文档一致"]),
        ViableOption(name="prompt 包投影", pros=["保留原始 prompt 信息"], cons=["MCP 客户端消费成本更高", "更容易演变成宿主私有规则"]),
    ]
    if deliberate:
        options.append(ViableOption(name="双层模式", pros=["兼顾保真与易用"], cons=["实现复杂度更高"]))
    return options


CHOICE_OPTIONS = [
    WorkflowChoiceOption(
        id="ralph",
        label="进入 ralph",
        description="按批准方案进入执行与验证闭环。",
        kind="tool",
        tool="ralph",
        recommended=True,
    ),
    WorkflowChoiceOption(
        id="plan",
        label="进入 plan",
        description="先把批准方案拆成更细执行计划。",
        kind="tool",
        tool="plan",
    ),
    WorkflowChoiceOption(
        id="mempalace_add_drawer",
        label="写入 mempalace_add_drawer",
        description="将规划摘要沉淀到长期记忆。",
        kind="tool",
        tool="mempalace_add_drawer",
    ),
]


def _phase_summary(
    phase: str,
    request: RalplanRequest,
    options: list[ViableOption],
    critic_verdict: str | None,
    revise: list[str],
) -> WorkflowPhaseSummary:
    if phase == "planner_draft":
        return WorkflowPhaseSummary(
            title="Planner 草案阶段",
            summary="ralplan 已产出可供宿主展示的初始分析框架，应先展示当前问题、候选方案和推荐方向，再继续进入 Architect 审查。",
            highlights=[
                f"任务：{request.task}",
                f"候选方案：{', '.join(option.name for option in options)}",
                "推荐方向：状态机投影",
            ],
        )
    if phase == "architect_review":
        return WorkflowPhaseSummary(
            title="Architect 审查阶段",
            summary="当前应围绕 Planner 草案进行架构边界、反例和 tradeoff 审查，完成后再进入 Critic 评价。",
            highlights=[
                "必须先完成 Architect，再进入 Critic",
                f"planner_draft 长度：{len(request.planner_draft or '')}",
                "重点检查边界、反例、tradeoff tension",
            ],
        )
    if phase == "revise":
        return WorkflowPhaseSummary(
            title="需要修订后重审",
            summary="Critic 尚未批准当前方案，宿主应先展示修订要点，再回到 Planner/Architect/Critic 闭环，而不是直接结束。",
            highlights=revise or ["请补齐 acceptance criteria、验证步骤和架构边界。"],
        )
    if phase in {"approved", "handoff_to_ralph"}:
        return WorkflowPhaseSummary(
            title="共识规划已批准",
            summary="当前 ralplan 已完成共识审查。宿主应展示批准摘要、优化结论和下一步 workflow 菜单，而不是仅展示结束文案。",
            highlights=[
                f"critic verdict：{critic_verdict or 'APPROVE'}",
                "推荐下一步：进入 ralph",
                "备选：进入 plan / 写入 mempalace_add_drawer",
            ],
        )
    return WorkflowPhaseSummary(
        title="Critic 终审阶段",
        summary="当前正在根据 Architect 反馈进行 Critic 质量评估，输出应包含 verdict 或修订要求。",
        highlights=[
            f"architect_feedback 条数：{len(request.architect_feedback)}",
            "重点检查测试性、风险和验证步骤是否具体",
        ],
    )


def _detect_critic_verdict(request: RalplanRequest) -> str:
    if request.critic_verdict_input:
        normalized = request.critic_verdict_input.strip().upper()
        if normalized in {"APPROVE", "REVISE", "REJECT"}:
            return normalized
    joined = "\n".join(request.critic_feedback)
    joined_upper = joined.upper()
    if "REJECT" in joined_upper or "驳回" in joined:
        return "REJECT"
    if "APPROVE" in joined_upper or "批准" in joined or "通过" in joined:
        return "APPROVE"
    if request.critic_feedback:
        return "REVISE"
    return "APPROVE"


def build_ralplan(request: RalplanRequest) -> RalplanResult:
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(request.known_context, request.memory_context)
    phase = request.current_phase
    options = _options(request.deliberate)
    chosen_option = "状态机投影"
    planner_prompt_ref = RolePromptRef(
        name="ralplan_planner_pass",
        arguments={
            "task": request.task,
            "deliberate": request.deliberate,
            "constraints": request.constraints,
        },
    )
    architect_prompt = None
    architect_prompt_ref = None
    critic_prompt = None
    critic_prompt_ref = None
    revise = []
    critic_verdict = None
    approved_plan_summary = None
    requested_input = None
    status = ToolStatus.OK
    readiness = "in_progress"
    if phase == "planner_draft":
        architect_prompt = "请以 Architect 视角审查当前 favored option 的边界、反例和 tradeoff。"
        architect_prompt_ref = RolePromptRef(
            name="ralplan_architect_pass",
            arguments={
                "task": request.task,
                "planner_draft": request.planner_draft or "",
                "deliberate": request.deliberate,
            },
        )
    elif phase == "architect_review":
        critic_prompt = "请以 Critic 视角检查 plan 的清晰度、测试性、风险和验证步骤。"
        critic_prompt_ref = RolePromptRef(
            name="ralplan_critic_pass",
            arguments={
                "task": request.task,
                "planner_draft": request.planner_draft or "",
                "architect_feedback": request.architect_feedback,
                "deliberate": request.deliberate,
            },
        )
    elif phase == "critic_review":
        critic_verdict = _detect_critic_verdict(request)
        if critic_verdict in {"REVISE", "REJECT"}:
            phase = "revise"
            revise = request.critic_feedback or ["请补齐 acceptance criteria、验证步骤和架构边界。"]
            readiness = "needs_revision" if critic_verdict == "REVISE" else "rejected"
            status = ToolStatus.NEEDS_INPUT
        else:
            phase = "approved"
            readiness = "ready_for_handoff"
            approved_plan_summary = f"已批准计划：{request.task}"
            requested_input = "下一步 workflow 选择优先通过 MCP Elicitation 获取；若宿主不支持或 UI 渲染异常，则应回退展示 choice_menu。"
    elif phase == "revise":
        phase = "architect_review"
        readiness = "needs_revision"
        status = ToolStatus.NEEDS_INPUT
    elif phase in {"approved", "handoff_to_ralph"}:
        phase = "handoff_to_ralph"
        readiness = "ready_for_handoff"
        approved_plan_summary = f"已批准计划：{request.task}"
        requested_input = "下一步 workflow 选择优先通过 MCP Elicitation 获取；若宿主不支持或 UI 渲染异常，则应回退展示 choice_menu。"
    phase_summary = _phase_summary(phase, request, options, critic_verdict, revise)
    choice_menu = None
    if phase in {"approved", "handoff_to_ralph"}:
        choice_menu = WorkflowChoiceMenu(
            title="请选择 ralplan 批准后的下一步 workflow",
            prompt="共识规划已批准。即使宿主未正确渲染 Elicitation，也应直接展示以下结构化选项与推荐项，而不是结束对话。",
            options=CHOICE_OPTIONS,
            recommended_option_id="ralph",
            fallback_instructions="selected_next_tool 为空时，宿主应保持会话继续，展示问题总结、优化方案与 options。",
        )
    state = WorkflowState(
        workflow_name="ralplan",
        current_phase=phase,
        readiness=readiness,
        evidence_gaps=[] if request.planner_draft or phase == "planner_draft" else ["缺少 planner draft 或评审反馈。"],
        blocked_reason=None,
        skill_source="skills/ralplan/SKILL.md",
        memory_preflight=MemoryPreflight(
            required=phase == "planner_draft" and not bool(request.constraints) and not bool(request.known_context),
            reason="进入 ralplan 共识规划前应读取相关记忆。",
            query=request.task,
            already_satisfied=bool(request.constraints) or bool(request.known_context) or phase != "planner_draft",
            search_performed=search_performed,
            retrieved_count=retrieved_count,
            retrieved_context=retrieved_context,
        ),
    )
    return RalplanResult(
        status=status,
        summary=f"已生成 ralplan 阶段 `{phase}` 的标准结构化结果。",
        assumptions=["批准态的下一步选择应优先通过 MCP Elicitation 获取。"],
        next_actions=[build_next_action("继续共识规划", requested_input or "继续按 planner → architect → critic 顺序推进。")],
        risks=[build_risk("若跳过 Architect 或 Critic 阶段，计划质量会显著下降。", "必须按顺序推进 planner → architect → critic。")],
        meta=build_meta("ralplan", "ymcp.contracts.ralplan.RalplanResult", host_controls=["MCP Elicitation", "state persistence", "display"]),
        artifacts=RalplanArtifacts(
            principles=["MCP 第一规范", "状态机投影优先", "以可测试计划为准"],
            decision_drivers=["MCP 标准能力", "结构化结果可消费", "减少宿主私有规则"],
            viable_options=options,
            chosen_option=chosen_option,
            adr=AdrDraft(
                decision="以 MCP 官方标准（Tools + Elicitation）为首要规范重构 workflow 交互。",
                drivers=["客户端可按标准能力实现交互", "避免自定义宿主协议", "便于跨客户端兼容"],
                alternatives_considered=[o.name for o in options],
                consequences=["需要用 Elicitation 替换自定义 interaction/continuation", "不支持 Elicitation 的客户端只能标准降级"],
                follow_ups=["批准后交给 ralph，或由用户选择 plan / mempalace_add_drawer。"],
            ),
            test_strategy=["单元测试各 phase 转移", "集成测试 Elicitation 能力分支", "客户端不支持 Elicitation 时返回标准降级结果"],
            planner_prompt_ref=planner_prompt_ref,
            architect_review_prompt=architect_prompt,
            architect_prompt_ref=architect_prompt_ref,
            critic_review_prompt=critic_prompt,
            critic_prompt_ref=critic_prompt_ref,
            revise_instructions=revise,
            workflow_state=state,
            phase_summary=phase_summary,
            critic_verdict=critic_verdict,
            approved_plan_summary=approved_plan_summary,
            requested_input=requested_input,
            choice_menu=choice_menu,
        ),
    )

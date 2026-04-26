from __future__ import annotations

from ymcp.contracts.checkpoint import (
    UserChoiceCheckpointArtifacts,
    UserChoiceCheckpointRequest,
    UserChoiceCheckpointResult,
    VerificationCheckpointArtifacts,
    VerificationCheckpointRequest,
    VerificationCheckpointResult,
    WorkflowCheckpointArtifacts,
    WorkflowCheckpointRequest,
    WorkflowCheckpointResult,
)
from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.workflow import CompletionGate, MemoryPreflight, QualityCheck, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action
from ymcp.engine.memory_preflight import analyze_memory_context


CHECKPOINT_LABELS = {
    'clarify': '需求澄清检查点',
    'plan': '计划检查点',
    'consensus': '共识检查点',
    'execution': '执行检查点',
}


def _memory_preflight(task: str, known_context: list[str], memory_context):
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(known_context, memory_context)
    has_context = bool(known_context or retrieved_context)
    return MemoryPreflight(
        required=not has_context,
        reason='在关键 checkpoint 前建议先读取历史记忆、约束和项目上下文。',
        query=task,
        already_satisfied=has_context,
        search_performed=search_performed,
        retrieved_count=retrieved_count,
        retrieved_context=retrieved_context,
    )


def build_workflow_checkpoint(request: WorkflowCheckpointRequest) -> WorkflowCheckpointResult:
    has_context = bool(request.known_context)
    has_evidence = bool(request.evidence)
    has_acceptance = bool(request.acceptance_criteria)
    has_questions = bool(request.outstanding_questions)

    checks = [
        QualityCheck(name='artifact_summary_present', passed=bool(request.artifact_summary.strip()), detail='已提供当前阶段摘要。'),
        QualityCheck(name='acceptance_criteria_present', passed=has_acceptance or request.checkpoint_type == 'clarify', detail='计划/共识/执行检查点建议提供至少一条验收标准。'),
        QualityCheck(name='context_grounded', passed=has_context or has_evidence, detail='建议至少提供代码、记忆或事实证据。'),
        QualityCheck(name='open_questions_controlled', passed=not has_questions, detail='存在未决问题时不应宣称当前阶段已完全收敛。'),
    ]

    if request.checkpoint_type == 'clarify':
        verdict = 'ready_for_planning' if bool(request.artifact_summary.strip()) and not has_questions else 'needs_refinement'
    elif request.checkpoint_type == 'plan':
        verdict = 'plan_ready' if has_acceptance and (has_context or has_evidence) and not has_questions else 'needs_refinement'
    elif request.checkpoint_type == 'consensus':
        verdict = 'approved' if has_acceptance and (has_context or has_evidence) and not has_questions else 'needs_revision'
    else:
        verdict = 'ready_for_verification' if has_evidence else 'needs_execution_evidence'

    readiness = {
        'ready_for_planning': 'ready',
        'plan_ready': 'ready',
        'approved': 'ready',
        'ready_for_verification': 'ready',
        'needs_execution_evidence': 'needs_input',
        'needs_refinement': 'needs_input',
        'needs_revision': 'needs_input',
    }[verdict]

    status = ToolStatus.OK if readiness == 'ready' else ToolStatus.NEEDS_INPUT
    next_steps = {
        'ready_for_planning': ['LLM 可直接进入规划 skill；如需用户决定下一步，可调用 user_choice_checkpoint。'],
        'plan_ready': ['LLM 可直接进入执行；如需用户批准或切换策略，可调用 user_choice_checkpoint。'],
        'approved': ['共识已通过；LLM 可继续执行，或调用 user_choice_checkpoint 收集用户明确选择。'],
        'ready_for_verification': ['执行证据已具备；下一步应调用 verification_checkpoint。'],
        'needs_execution_evidence': ['先补充实现/运行证据，再进入 verification_checkpoint。'],
        'needs_refinement': ['继续由 LLM 自主澄清/完善，不必逐步回 MCP。'],
        'needs_revision': ['继续由 LLM 自主修订方案，再回到 consensus checkpoint。'],
    }[verdict]

    label = CHECKPOINT_LABELS[request.checkpoint_type]
    summary = f'{label}：{verdict}。'
    state = WorkflowState(
        workflow_name='workflow_checkpoint',
        current_phase=request.checkpoint_type,
        readiness=readiness,
        evidence_gaps=request.outstanding_questions if has_questions else ([] if has_context or has_evidence else ['缺少项目上下文或外部证据。']),
        memory_preflight=_memory_preflight(request.task, request.known_context, request.memory_context),
    )
    return WorkflowCheckpointResult(
        status=status,
        summary=summary,
        assumptions=[],
        next_actions=[build_next_action('下一步', next_steps[0])],
        risks=[],
        meta=build_meta(
            'workflow_checkpoint',
            'ymcp.contracts.checkpoint.WorkflowCheckpointResult',
            host_controls=['display', 'memory lookup', 'user interaction'],
            required_host_action=HostActionType.DISPLAY_ONLY,
        ),
        artifacts=WorkflowCheckpointArtifacts(
            checkpoint_type=request.checkpoint_type,
            verdict=verdict,
            quality_checks=checks,
            recommended_next_steps=next_steps,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title=label, summary='Ymcp 只做阶段检查，不接管 LLM 的常规推理循环。'),
        ),
    )


def build_user_choice_checkpoint(request: UserChoiceCheckpointRequest) -> UserChoiceCheckpointResult:
    option_values = {option.value for option in request.options}
    selected = request.selected_option.strip() if request.selected_option else None
    invalid_selection = bool(selected and selected not in option_values)
    awaiting_choice = selected is None or invalid_selection

    summary = '需要用户显式选择下一步。' if awaiting_choice else f'已记录用户选择：{selected}。'
    evidence_gaps = ['尚未收到用户显式选择。'] if selected is None else ([f'无效选项：{selected}'] if invalid_selection else [])
    status = ToolStatus.NEEDS_INPUT if awaiting_choice else ToolStatus.OK
    required_action = HostActionType.AWAIT_INPUT if awaiting_choice else HostActionType.CALL_SELECTED_TOOL

    return UserChoiceCheckpointResult(
        status=status,
        summary=summary,
        assumptions=[],
        next_actions=[build_next_action('下一步', '展示结构化选项并等待用户确认。' if awaiting_choice else f'按用户选择 `{selected}` 继续。')],
        risks=[],
        meta=build_meta(
            'user_choice_checkpoint',
            'ymcp.contracts.checkpoint.UserChoiceCheckpointResult',
            host_controls=['MCP Elicitation', 'display'],
            required_host_action=required_action,
            safe_to_auto_continue=not awaiting_choice,
            requires_elicitation=awaiting_choice,
            requires_explicit_user_choice=True,
            selected_next_tool=None if awaiting_choice else selected,
        ),
        artifacts=UserChoiceCheckpointArtifacts(
            stage=request.stage,
            prompt=request.prompt,
            options=request.options,
            selected_option=None if awaiting_choice else selected,
            workflow_state=WorkflowState(
                workflow_name='user_choice_checkpoint',
                current_phase=request.stage,
                readiness='needs_user_choice' if awaiting_choice else 'choice_recorded',
                evidence_gaps=evidence_gaps,
                blocked_reason='所选值不在 options 中。' if invalid_selection else None,
            ),
            phase_summary=WorkflowPhaseSummary(title='用户选择检查点', summary='Ymcp 仅在必须由用户确认的节点介入。'),
        ),
    )


def build_verification_checkpoint(request: VerificationCheckpointRequest) -> VerificationCheckpointResult:
    gates = [
        CompletionGate(name='has_latest_evidence', satisfied=bool(request.latest_evidence), detail='需要最新实现或运行证据。'),
        CompletionGate(name='has_verification_commands', satisfied=bool(request.verification_commands), detail='需要验证命令或等价验证方案。'),
        CompletionGate(name='has_verification_results', satisfied=bool(request.verification_results), detail='需要真实验证结果。'),
        CompletionGate(name='regression_passed', satisfied=request.regression_status == 'passed', detail='回归状态应为 passed。'),
        CompletionGate(name='release_notes_ready', satisfied=request.release_notes_ready, detail='如果要对外收尾，建议整理完成摘要或 release notes。'),
    ]

    if request.known_failures:
        verdict = 'fix_failures'
        status = ToolStatus.NEEDS_INPUT
        missing = list(request.known_failures)
        summary = '存在失败项，先修复再验证。'
    elif not request.latest_evidence:
        verdict = 'needs_more_evidence'
        status = ToolStatus.NEEDS_INPUT
        missing = ['latest_evidence']
        summary = '缺少最新执行证据。'
    elif not request.verification_commands:
        verdict = 'needs_verification_plan'
        status = ToolStatus.NEEDS_INPUT
        missing = ['verification_commands']
        summary = '缺少验证计划。'
    elif not request.verification_results:
        verdict = 'needs_verification_results'
        status = ToolStatus.NEEDS_INPUT
        missing = ['verification_results']
        summary = '缺少验证结果。'
    elif request.regression_status != 'passed':
        verdict = 'regression_incomplete'
        status = ToolStatus.NEEDS_INPUT
        missing = ['regression_status=passed']
        summary = '回归状态未通过。'
    else:
        verdict = 'complete'
        status = ToolStatus.OK
        missing = []
        summary = '验证检查点通过，当前任务可视为完成。'

    next_steps = {
        'fix_failures': ['继续由 LLM 修复失败项，再次调用 verification_checkpoint。'],
        'needs_more_evidence': ['补充实现/运行证据后再次验证。'],
        'needs_verification_plan': ['补充验证命令或等价验证步骤。'],
        'needs_verification_results': ['执行验证并回填真实结果。'],
        'regression_incomplete': ['完成回归验证并将 regression_status 设为 passed。'],
        'complete': ['如需用户决定收尾方式，调用 user_choice_checkpoint；如需沉淀经验，调用 mempalace_add_drawer。'],
    }[verdict]

    return VerificationCheckpointResult(
        status=status,
        summary=summary,
        assumptions=[],
        next_actions=[build_next_action('下一步', next_steps[0])],
        risks=[],
        meta=build_meta(
            'verification_checkpoint',
            'ymcp.contracts.checkpoint.VerificationCheckpointResult',
            host_controls=['display', 'execution', 'verification'],
            required_host_action=HostActionType.DISPLAY_ONLY,
        ),
        artifacts=VerificationCheckpointArtifacts(
            verdict=verdict,
            completion_gates=gates,
            missing_evidence=missing,
            recommended_next_steps=next_steps,
            workflow_state=WorkflowState(
                workflow_name='verification_checkpoint',
                current_phase='verification',
                readiness='complete' if verdict == 'complete' else 'needs_input',
                evidence_gaps=missing,
                blocked_reason='；'.join(request.known_failures) if request.known_failures else None,
            ),
            phase_summary=WorkflowPhaseSummary(title='验证检查点', summary='Ymcp 只负责判断证据与完成态，不接管执行循环。'),
        ),
    )

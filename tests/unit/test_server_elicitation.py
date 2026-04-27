import anyio

from ymcp.contracts.common import ElicitationState, HostActionType, ToolStatus
from ymcp.contracts.ralplan import RalplanCompleteRequest
from ymcp.engine.ralplan import build_ralplan_complete
from ymcp.server import _maybe_elicit_handoff_choice


class _FakeAcceptedElicitation:
    action = 'accept'

    class data:
        choice = 'ydo'


class _FakeAcceptedContext:
    request_context = object()

    async def elicit(self, message, schema):
        assert schema.model_fields['choice'].annotation is str
        assert 'handoff.options 中的全部菜单项' in message
        return _FakeAcceptedElicitation()


class _FakeDeclinedElicitation:
    action = 'decline'
    data = None


class _FakeDeclinedContext:
    request_context = object()

    async def elicit(self, message, schema):
        return _FakeDeclinedElicitation()


class _FakeFailingContext:
    request_context = object()

    async def elicit(self, message, schema):
        raise RuntimeError('boom')


def test_complete_helper_blocks_without_request_context():
    async def _run():
        result = build_ralplan_complete(RalplanCompleteRequest())
        updated = await _maybe_elicit_handoff_choice(None, result, message_prefix='规划完成')
        assert updated.status is ToolStatus.OK
        assert updated.meta.elicitation_required is False

        result_with_ctx = build_ralplan_complete(RalplanCompleteRequest())
        class _NoRequestContext:
            request_context = None
        updated = await _maybe_elicit_handoff_choice(_NoRequestContext(), result_with_ctx, message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.required_host_action is HostActionType.DISPLAY_ONLY
        assert updated.meta.elicitation_required is True
        assert updated.meta.elicitation_state is ElicitationState.UNSUPPORTED
        assert updated.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.readiness == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.current_focus == 'elicitation_failed_fallback_to_manual'
        assert updated.artifacts.workflow_state.blocked_reason == 'manual_menu_required'
        assert '未提供可用的 MCP Elicitation 上下文' in updated.summary
        assert '手动菜单展示兜底' in updated.summary
        assert '完整展示全部菜单项的 value、title、description' in updated.summary
        assert '[recommended]' in updated.summary
        assert updated.next_actions[0].label == '展示菜单并等待用户选择'
    anyio.run(_run)


def test_complete_helper_records_selected_option_on_accept():
    async def _run():
        result = build_ralplan_complete(RalplanCompleteRequest())
        updated = await _maybe_elicit_handoff_choice(_FakeAcceptedContext(), result, message_prefix='规划完成')
        assert updated.status is ToolStatus.OK
        assert updated.meta.required_host_action is HostActionType.DISPLAY_ONLY
        assert updated.meta.elicitation_required is True
        assert updated.meta.elicitation_state is ElicitationState.ACCEPTED
        assert updated.meta.elicitation_selected_option == 'ydo'
        assert updated.artifacts.selected_option == 'ydo'
        assert updated.artifacts.workflow_state.current_phase == 'selection_confirmed'
        assert updated.artifacts.workflow_state.readiness == 'selection_confirmed'
        assert updated.artifacts.workflow_state.current_focus == 'selected:ydo'
        assert updated.artifacts.workflow_state.blocked_reason is None
    anyio.run(_run)


def test_complete_helper_requires_retry_on_decline():
    async def _run():
        result = build_ralplan_complete(RalplanCompleteRequest())
        updated = await _maybe_elicit_handoff_choice(_FakeDeclinedContext(), result, message_prefix='规划完成')
        assert updated.status is ToolStatus.NEEDS_INPUT
        assert updated.meta.required_host_action is HostActionType.AWAIT_INPUT
        assert updated.meta.elicitation_required is True
        assert updated.meta.elicitation_state is ElicitationState.DECLINED
        assert updated.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.readiness == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.current_focus == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.blocked_reason == 'user_choice_pending'
    anyio.run(_run)


def test_complete_helper_blocks_on_elicitation_failure():
    async def _run():
        result = build_ralplan_complete(RalplanCompleteRequest())
        updated = await _maybe_elicit_handoff_choice(_FakeFailingContext(), result, message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.required_host_action is HostActionType.DISPLAY_ONLY
        assert updated.meta.elicitation_required is True
        assert updated.meta.elicitation_state is ElicitationState.FAILED
        assert updated.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.readiness == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.current_focus == 'elicitation_failed_fallback_to_manual'
        assert updated.artifacts.workflow_state.blocked_reason == 'manual_menu_required'
        assert 'Elicitation 调用失败' in updated.summary
        assert 'RuntimeError: boom' in updated.summary
        assert '手动菜单展示兜底' in updated.summary
        assert '[recommended]' in updated.summary
        assert updated.next_actions[0].label == '展示菜单并等待用户选择'
    anyio.run(_run)


def test_complete_helper_blocks_on_illegal_selected_option():
    class _FakeIllegalAcceptedElicitation:
        action = 'accept'

        class data:
            choice = 'invalid'

    class _FakeIllegalAcceptedContext:
        request_context = object()

        async def elicit(self, message, schema):
            return _FakeIllegalAcceptedElicitation()

    async def _run():
        result = build_ralplan_complete(RalplanCompleteRequest())
        updated = await _maybe_elicit_handoff_choice(_FakeIllegalAcceptedContext(), result, message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.elicitation_state is ElicitationState.FAILED
        assert updated.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.readiness == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.current_focus == 'elicitation_failed_fallback_to_manual'
        assert '非法选项' in updated.summary
        assert 'ydo, restart, memory_store' in updated.summary
        assert '手动菜单展示兜底' in updated.summary
    anyio.run(_run)

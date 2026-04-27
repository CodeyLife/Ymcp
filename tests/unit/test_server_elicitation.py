import anyio

from ymcp.contracts.common import ElicitationState, HostActionType, ToolStatus
from ymcp.contracts.ralplan import RalplanCompleteRequest
from ymcp.engine.ralplan import build_ralplan_complete
from ymcp.server import _maybe_elicit_handoff_choice


def _assert_host_ui_fallback(result):
    assert result.summary == 'WORKFLOW_PAUSED_AWAITING_SELECTED_OPTION'
    assert result.meta.interaction_kind == 'awaiting_selected_option'
    assert result.meta.menu_authority == 'not_exposed_to_assistant'
    assert result.meta.assistant_response_policy == 'stop_after_tool_result'
    assert result.meta.auto_continue_forbidden is True
    assert result.meta.assistant_visible_response_allowed is False
    assert result.meta.host_ui_required is False
    assert result.meta.text_menu_forbidden is True
    assert result.meta.host_controls == []
    assert result.meta.ui_request['kind'] == 'await_selected_option'
    assert result.meta.ui_request['selected_option_param'] == 'selected_option'
    assert result.meta.ui_request['failure_semantics'] == 'not_a_tool_failure'
    assert result.meta.ui_request['assistant_instruction'] == 'STOP'
    assert set(result.meta.ui_request) == {
        'kind',
        'selected_option_param',
        'failure_semantics',
        'assistant_instruction',
    }
    assert result.meta.handoff.options == []
    assert result.meta.handoff.recommended_next_action is None
    assert result.next_actions == []


class _FakeAcceptedElicitation:
    action = 'accept'

    class data:
        choice = 'ydo'


class _FakeAcceptedContext:
    request_context = object()

    async def elicit(self, message, schema):
        assert schema.model_fields['choice'].annotation is str
        choice_schema = schema.model_json_schema()['properties']['choice']
        assert choice_schema['enum'] == ['ydo', 'restart', 'memory_store']
        assert choice_schema['default'] == 'ydo'
        assert choice_schema['title'] == '下一步'
        assert '宿主 UI 控件渲染' in message
        assert 'assistant 不得用自然语言或 markdown 列表代渲染选项' in message
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
        result = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准，验收和验证路径明确'))
        updated = await _maybe_elicit_handoff_choice(None, result, message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.required_host_action is HostActionType.AWAIT_INPUT
        assert updated.meta.elicitation_required is True
        assert updated.meta.elicitation_state is ElicitationState.UNSUPPORTED
        assert updated.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.readiness == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.current_focus == 'fallback_requires_interactive_menu'
        _assert_host_ui_fallback(updated)

        result_with_ctx = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准，验收和验证路径明确'))
        class _NoRequestContext:
            request_context = None
        updated = await _maybe_elicit_handoff_choice(_NoRequestContext(), result_with_ctx, message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.required_host_action is HostActionType.AWAIT_INPUT
        assert updated.meta.elicitation_required is True
        assert updated.meta.elicitation_state is ElicitationState.UNSUPPORTED
        assert updated.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.readiness == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.current_focus == 'fallback_requires_interactive_menu'
        assert updated.artifacts.workflow_state.blocked_reason == 'interactive_menu_required'
        _assert_host_ui_fallback(updated)
    anyio.run(_run)


def test_complete_helper_skips_elicitation_when_selected_option_is_confirmed():
    async def _run():
        result = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准', selected_option='restart'))
        updated = await _maybe_elicit_handoff_choice(_FakeFailingContext(), result, message_prefix='规划完成')
        assert updated.status is ToolStatus.OK
        assert updated.meta.required_host_action is HostActionType.DISPLAY_ONLY
        assert updated.meta.elicitation_required is False
        assert updated.meta.elicitation_selected_option == 'restart'
        assert updated.artifacts.selected_option == 'restart'
        assert updated.artifacts.workflow_state.current_phase == 'selection_confirmed'
        assert updated.artifacts.workflow_state.readiness == 'selection_confirmed'
        assert updated.artifacts.workflow_state.current_focus == 'selected:restart'
    anyio.run(_run)


def test_complete_helper_keeps_invalid_selected_option_blocked():
    async def _run():
        result = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准', selected_option='invalid'))
        updated = await _maybe_elicit_handoff_choice(_FakeAcceptedContext(), result, message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.required_host_action is HostActionType.AWAIT_INPUT
        assert updated.meta.elicitation_required is False
        assert updated.artifacts.selected_option is None
        assert updated.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.current_focus == 'invalid_selected_option'
        assert '非法 selected_option' in updated.summary
    anyio.run(_run)


def test_complete_helper_records_selected_option_on_accept():
    async def _run():
        result = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准，验收和验证路径明确'))
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
        result = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准，验收和验证路径明确'))
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
        result = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准，验收和验证路径明确'))
        updated = await _maybe_elicit_handoff_choice(_FakeFailingContext(), result, message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.required_host_action is HostActionType.AWAIT_INPUT
        assert updated.meta.elicitation_required is True
        assert updated.meta.elicitation_state is ElicitationState.FAILED
        assert updated.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.readiness == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.current_focus == 'fallback_requires_interactive_menu'
        assert updated.artifacts.workflow_state.blocked_reason == 'interactive_menu_required'
        _assert_host_ui_fallback(updated)
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
        result = build_ralplan_complete(RalplanCompleteRequest(critic_summary='critic 已批准，验收和验证路径明确'))
        updated = await _maybe_elicit_handoff_choice(_FakeIllegalAcceptedContext(), result, message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.elicitation_state is ElicitationState.FAILED
        assert updated.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.readiness == 'awaiting_user_selection'
        assert updated.artifacts.workflow_state.current_focus == 'fallback_requires_interactive_menu'
        _assert_host_ui_fallback(updated)
    anyio.run(_run)

import anyio

from ymcp.contracts.common import ElicitationState, HandoffOption, ToolStatus
from ymcp.contracts.menu import MenuRequest
from ymcp.engine.menu import build_menu
from ymcp.server import _maybe_elicit_handoff_choice


def _menu_result():
    return build_menu(MenuRequest(
        source_workflow='yplan',
        summary='规划完成',
        options=[
            HandoffOption(value='ydo', title='进入 ydo', description='执行', recommended=True),
            HandoffOption(value='memory_store', title='保存记忆', description='保存'),
        ],
    ))


def _assert_webui_fallback(result):
    assert result.summary.startswith('WORKFLOW_PAUSED_AWAITING_SELECTED_OPTION')
    assert result.meta.menu_authority == 'meta.handoff.options'
    assert result.meta.elicitation_error
    assert result.meta.host_controls == ['display', 'webui fallback', 'selected_option tool recall']
    assert result.meta.ui_request['kind'] == 'await_selected_option'
    assert result.meta.ui_request['selected_option_param'] == 'selected_option'
    assert result.meta.ui_request['webui_url'].startswith('http://127.0.0.1:')
    assert result.meta.ui_request['menu_session_id']
    assert [option.value for option in result.meta.handoff.options] == ['ydo', 'memory_store']
    assert result.artifacts.webui_url == result.meta.ui_request['webui_url']
    assert result.artifacts.menu_session_id == result.meta.ui_request['menu_session_id']
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
        assert choice_schema['enum'] == ['ydo', 'memory_store']
        assert choice_schema['default'] == 'ydo'
        assert '宿主 UI 控件渲染' in message
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


def test_menu_helper_starts_webui_without_request_context():
    async def _run():
        updated = await _maybe_elicit_handoff_choice(None, _menu_result(), message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.elicitation_required is True
        assert updated.meta.elicitation_state is ElicitationState.UNSUPPORTED
        assert '未提供 MCP Elicitation 上下文' in updated.meta.elicitation_error
        assert updated.artifacts.workflow_state.current_phase == 'awaiting_user_selection'
        _assert_webui_fallback(updated)
    anyio.run(_run)


def test_menu_helper_skips_elicitation_when_selected_option_is_confirmed():
    async def _run():
        result = build_menu(MenuRequest(source_workflow='yplan', summary='规划完成', options=[HandoffOption(value='ydo', title='进入', description='执行')], selected_option='ydo'))
        updated = await _maybe_elicit_handoff_choice(_FakeFailingContext(), result, message_prefix='规划完成')
        assert updated.status is ToolStatus.OK
        assert updated.meta.elicitation_required is False
        assert updated.meta.elicitation_selected_option == 'ydo'
        assert updated.artifacts.selected_option == 'ydo'
    anyio.run(_run)


def test_menu_helper_records_selected_option_on_accept():
    async def _run():
        updated = await _maybe_elicit_handoff_choice(_FakeAcceptedContext(), _menu_result(), message_prefix='规划完成')
        assert updated.status is ToolStatus.OK
        assert updated.meta.elicitation_required is True
        assert updated.meta.elicitation_state is ElicitationState.ACCEPTED
        assert updated.meta.elicitation_selected_option == 'ydo'
        assert updated.artifacts.selected_option == 'ydo'
        assert updated.artifacts.workflow_state.current_phase == 'selection_confirmed'
    anyio.run(_run)


def test_menu_helper_uses_webui_fallback_on_decline():
    async def _run():
        updated = await _maybe_elicit_handoff_choice(_FakeDeclinedContext(), _menu_result(), message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.elicitation_required is True
        assert updated.meta.elicitation_state is ElicitationState.DECLINED
        assert 'Elicitation 未完成（decline）' in updated.meta.elicitation_error
        _assert_webui_fallback(updated)
    anyio.run(_run)


def test_menu_helper_blocks_on_elicitation_failure_with_webui():
    async def _run():
        updated = await _maybe_elicit_handoff_choice(_FakeFailingContext(), _menu_result(), message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.elicitation_required is True
        assert updated.meta.elicitation_state is ElicitationState.FAILED
        assert updated.meta.elicitation_error == 'Elicitation 调用失败（RuntimeError: boom）'
        _assert_webui_fallback(updated)
    anyio.run(_run)


def test_menu_helper_blocks_on_illegal_elicitation_option_with_webui():
    class _FakeIllegalAcceptedElicitation:
        action = 'accept'

        class data:
            choice = 'invalid'

    class _FakeIllegalAcceptedContext:
        request_context = object()

        async def elicit(self, message, schema):
            return _FakeIllegalAcceptedElicitation()

    async def _run():
        updated = await _maybe_elicit_handoff_choice(_FakeIllegalAcceptedContext(), _menu_result(), message_prefix='规划完成')
        assert updated.status is ToolStatus.BLOCKED
        assert updated.meta.elicitation_state is ElicitationState.FAILED
        assert 'Elicitation 返回了非法选项 `invalid`' in updated.meta.elicitation_error
        _assert_webui_fallback(updated)
    anyio.run(_run)

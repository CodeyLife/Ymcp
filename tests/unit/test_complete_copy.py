from ymcp.complete_copy import with_blocked_on_unsupported_elicitation, with_handoff_menu_requirement
from ymcp.internal_registry import get_tool_specs


def test_complete_copy_helpers_keep_common_contract_suffixes():
    blocked = with_blocked_on_unsupported_elicitation('前置说明。')
    assert '统一 menu tool 应返回 blocked' in blocked
    assert 'WebUI fallback' in blocked

    menu = with_handoff_menu_requirement('前置说明。', closing='不得自动继续')
    assert 'handoff.options' in menu
    assert '通过 Elicitation 或等价可交互控件展示全部可选项' in menu
    assert '不要求逐字多行还原' in menu
    assert menu.endswith('不得自动继续。')


def test_menu_tool_description_mentions_elicitation_and_webui_fallback():
    descriptions = {spec.name: spec.description for spec in get_tool_specs()}
    assert set(name for name in descriptions if name.endswith('_menu')) == set()
    assert 'workflow-menu' in descriptions['menu']
    assert 'Elicitation' in descriptions['menu']
    assert 'WebUI fallback' in descriptions['menu']

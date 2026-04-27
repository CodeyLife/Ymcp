from ymcp.complete_copy import with_blocked_on_unsupported_elicitation, with_handoff_menu_requirement
from ymcp.internal_registry import get_tool_specs


def test_complete_copy_helpers_keep_common_contract_suffixes():
    blocked = with_blocked_on_unsupported_elicitation('前置说明。')
    assert blocked.endswith('若宿主不支持 Elicitation，则本 tool 应返回 blocked，并要求宿主以 handoff.options 渲染可交互菜单。')

    menu = with_handoff_menu_requirement('前置说明。', closing='不得自动继续')
    assert 'handoff.options' in menu
    assert '通过 Elicitation 或等价可交互菜单完整展示全部菜单项' in menu
    assert menu.endswith('不得自动继续。')


def test_complete_tool_descriptions_share_blocked_contract():
    descriptions = {
        spec.name: spec.description
        for spec in get_tool_specs()
        if spec.name in {'ydeep_complete', 'yplan_complete', 'ydo_complete'}
    }

    assert descriptions.keys() == {'ydeep_complete', 'yplan_complete', 'ydo_complete'}
    for description in descriptions.values():
        assert description.endswith('若宿主不支持 Elicitation，则本 tool 应返回 blocked，并要求宿主以 handoff.options 渲染可交互菜单。')

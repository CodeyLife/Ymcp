from __future__ import annotations


COMPLETE_TOOL_BLOCKED_SUFFIX = '若宿主不支持 Elicitation，则本流程菜单 tool 应返回 blocked，并要求宿主以 handoff.options 渲染真实可交互菜单；普通文本列表或 assistant 代渲染不能替代交互选择。'
COMPLETE_HANDOFF_MENU_PREFIX = '宿主现在必须以 `handoff.options` 作为唯一权威菜单数据源，通过 Elicitation 或等价可交互控件展示全部可选项'
COMPLETE_HANDOFF_MENU_REQUIREMENT = '必须保留每个选项的 value/title/recommended，description 可作为详情、tooltip 或辅助文本呈现，不要求逐字多行还原'


def compose_sentences(*parts: str) -> str:
    sentences: list[str] = []
    for part in parts:
        text = part.strip()
        if not text:
            continue
        sentences.append(text.rstrip('。') + '。')
    return ''.join(sentences)


def with_blocked_on_unsupported_elicitation(*parts: str) -> str:
    return compose_sentences(*parts, COMPLETE_TOOL_BLOCKED_SUFFIX)


def with_handoff_menu_requirement(*parts: str, closing: str = '不得自动继续') -> str:
    return compose_sentences(*parts, f'{COMPLETE_HANDOFF_MENU_PREFIX}，{COMPLETE_HANDOFF_MENU_REQUIREMENT}，{closing}')

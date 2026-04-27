from __future__ import annotations


COMPLETE_TOOL_BLOCKED_SUFFIX = '若宿主不支持 Elicitation，则本 tool 应返回 blocked，并要求宿主以 handoff.options 渲染可交互菜单。'
COMPLETE_HANDOFF_MENU_PREFIX = '宿主现在必须以 `handoff.options` 作为唯一权威菜单数据源，通过 Elicitation 或等价可交互菜单完整展示全部菜单项'
COMPLETE_HANDOFF_MENU_REQUIREMENT = '不得省略、改写、新增'


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

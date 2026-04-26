from __future__ import annotations

from typing import Any

FIXTURES: dict[str, dict[str, Any]] = {
    'ydeep': {'brief': '为当前任务先澄清目标与边界'},
    'ydeep_complete': {
        'summary': '已总结当前需求边界、现状与改进方向。',
        'brief': '为当前任务先澄清目标与边界',
    },
    'yplan': {
        'task': '为恢复三阶段 planning workflow 收敛共识方案',
    },
    'yplan_architect': {},
    'yplan_critic': {},
    'yplan_complete': {},
    'ydo': {},
    'ydo_complete': {},
    'mempalace_status': {},
    'mempalace_search': {'query': 'Ymcp workflow tools', 'limit': 3},
}


def fixture_for(tool_name: str) -> dict[str, Any]:
    try:
        return dict(FIXTURES[tool_name])
    except KeyError as exc:
        available = ', '.join(sorted(FIXTURES))
        raise ValueError(f"Unknown fixture tool {tool_name!r}; available: {available}") from exc

from __future__ import annotations

from typing import Any

FIXTURES: dict[str, dict[str, Any]] = {
    'ydeep': {'brief': '为当前任务先澄清目标与边界'},
    'ydeep_complete': {
        'brief': '为当前任务先澄清目标与边界',
        'summary': '已总结当前需求边界、现状与改进方向。',
    },
    'yplan': {
        'task': '为恢复三工具架构收敛共识方案',
    },
    'yplan_architect': {
        'task': '为恢复三工具架构收敛共识方案',
        'plan_summary': '保留 deep_interview / ralplan / ralph 三个 tool，内部思考由 skill 驱动。',
        'planner_notes': ['确定三工具外壳保留'],
    },
    'yplan_critic': {
        'task': '为恢复三工具架构收敛共识方案',
        'plan_summary': '保留 deep_interview / ralplan / ralph 三个 tool，内部思考由 skill 驱动。',
        'planner_notes': ['确定三工具外壳保留'],
        'architect_notes': ['tool 负责 gate，不负责内部思考'],
        'critic_verdict': 'APPROVE',
        'critic_notes': ['方案满足当前共识与验收要求。'],
        'acceptance_criteria': ['ralplan 完成后可选择使用 ralph 执行任务'],
    },
    'yplan_complete': {
        'task': '为恢复三工具架构收敛共识方案',
        'summary': '已形成完整方案摘要、关键决策和下一步建议。',
        'critic_verdict': 'APPROVE',
        'plan_summary': '保留 deep_interview / ralplan / ralph 三个 tool，内部思考由 skill 驱动。',
        'planner_notes': ['确定三工具外壳保留'],
        'architect_notes': ['tool 负责 gate，不负责内部思考'],
        'critic_notes': ['共识通过后必须有 Elicitation'],
        'acceptance_criteria': ['ralplan 完成后可选择使用 ralph 执行任务'],
    },
    'ydo': {
        'approved_plan': '按批准方案恢复三工具架构',
    },
    'ydo_complete': {
        'approved_plan': '按批准方案恢复三工具架构',
        'summary': '已完成执行、验证和结果整理，可进入收尾。',
    },
    'mempalace_status': {},
    'mempalace_search': {'query': 'Ymcp workflow tools', 'limit': 3},
}


def fixture_for(tool_name: str) -> dict[str, Any]:
    try:
        return dict(FIXTURES[tool_name])
    except KeyError as exc:
        available = ', '.join(sorted(FIXTURES))
        raise ValueError(f"Unknown fixture tool {tool_name!r}; available: {available}") from exc

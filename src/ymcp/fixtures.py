from __future__ import annotations

from typing import Any

FIXTURES: dict[str, dict[str, Any]] = {
    'ydeep': {'brief': '为当前任务先澄清目标与边界'},
    'yplan': {
        'task': '为恢复三阶段 planning workflow 收敛共识方案',
    },
    'yimggen': {'brief': '生成 8 帧本地 Pillow 小球动画', 'asset_slug': 'fixture-ball', 'dimensions': '64x64', 'frame_count': 8},
    'ydo': {},
    'menu': {
        'source_workflow': 'yplan',
        'summary': '规划阶段已完成，执行边界与验证路径明确。',
        'options': [
            {
                'value': 'ydo',
                'title': '进入 ydo',
                'description': '进入执行与验证阶段。',
                'recommended': True,
            },
            {
                'value': 'yplan',
                'title': '重新规划',
                'description': '回到规划阶段重新收敛方案。',
                'recommended': False,
            },
        ],
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

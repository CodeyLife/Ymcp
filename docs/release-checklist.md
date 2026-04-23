# 发布清单

- 运行 `python -m pip install -e .[dev]`
- 运行 `python -m pytest`
- 运行 `python -m build`
- 检查 `dist/` 中的 wheel 和 sdist
- 运行 `ymcp --version`
- 运行 `ymcp inspect-tools --json`
- 运行 `ymcp doctor --json`
- 运行 `ymcp print-config --host trae`
- 运行 `python examples/host_call_all_tools.py`
- 先发布到 TestPyPI，并验证干净环境安装
- TestPyPI 冒烟验证通过后再发布到正式 PyPI
- 确认文档没有承诺 v1 会提供在线市场、公开插件 API 或技能库能力

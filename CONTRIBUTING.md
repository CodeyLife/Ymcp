# 贡献指南

1. 使用 `python -m pip install -e .[dev]` 安装开发依赖。
2. 提交变更前运行 `python -m pytest`。
3. 保持 MCP 边界：Ymcp 工具不得执行命令、spawn agent、修改文件或拥有交互循环。
4. 将工具契约视为公共 API。破坏性的 request/response 变更必须提升 schema version，并提供迁移说明。

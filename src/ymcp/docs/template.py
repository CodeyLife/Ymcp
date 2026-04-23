TRAE_PROJECT_RULE_TEMPLATE = """# Ymcp 项目规则（Trae）

## 目标
- 当前项目使用 Ymcp 作为 MCP 工作流工具服务器。
- 优先通过 `plan`、`ralplan`、`deep_interview`、`ralph` 获取结构化指导，而不是把 Ymcp 当作自动执行器。

## 使用边界
- 不要把 Ymcp 工具当作 agent runtime。
- `deep_interview` 只提供下一问建议，由宿主或用户继续回答。
- `ralph` 只提供下一步和验证清单，不执行命令、不修改文件。

## 推荐调用顺序
1. 需求不清晰时先用 `deep_interview`
2. 明确后用 `plan` 或 `ralplan`
3. 实施过程中用 `ralph` 判断下一步和验证项

## 输出要求
- 优先返回结构化结论
- 明确列出风险、假设、下一步
- 发现信息不足时优先返回 `needs_input`
"""

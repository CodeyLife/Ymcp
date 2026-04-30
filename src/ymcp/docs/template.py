TRAE_PROJECT_RULE_TEMPLATE = """
# 项目规则

- `handoff.options` 是下一步菜单的唯一权威源。
- `recommended_next_action` / `recommended: true` 只表示推荐，不授权自动执行。
- 仅非空 `artifacts.selected_option` 或 `meta.elicitation_selected_option` 表示用户已选择；`selected_option` 为 `null` 时表示用户尚未选择任何菜单项。
- 严禁根据 `recommended_next_action`、上下文、原始需求或推理推断/模拟/假设用户选择。
- `status=blocked` 且 `ui_request.kind=await_selected_option` 时，必须停止规划、分析、执行和下一步 tool 调用，并等待合法 `option.value`。
- 用户直接回复合法 `option.value` 时，必须原样作为 `selected_option` 回传当前菜单 tool。
- Elicitation 不可用或失败时，必须按 `handoff.options` 渲染交互菜单并等待选择，不得自动推进。
- blocked fallback 仅供宿主 UI 使用；assistant 不得用普通文本或 markdown 列表代渲染菜单。

## 记忆规则

- 历史事实、项目约定、偏好、决策或上下文必须先用 `mempalace_search` / `mempalace_get_drawer` 核验。
- 写入长期记忆前必须查重；事实变化时更新、删除或失效旧内容。

"""

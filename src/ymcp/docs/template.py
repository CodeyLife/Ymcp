TRAE_PROJECT_RULE_TEMPLATE = """
# 项目规则

## Ymcp 必须约定

- `ydeep`/`yplan`/`ydo` 返回 `skill_content` 后，必须先按 skill 完成当前阶段并输出总结，再调用 `menu`。其中 `yplan` 的 planner/architect/critic 是同一 skill 内部步骤。
- `handoff.options` 是下一步菜单唯一权威源；`recommended_next_action`/`recommended:true` 只表示推荐，不授权自动执行。
- 严禁根据 `recommended_next_action`、上下文或推理推断/模拟/假设用户选择；用户回复合法 `option.value` 时，原样作为 `selected_option` 回传 `menu`。
- `status=blocked` 且 `meta.ui_request.kind=await_selected_option` 时，必须停止规划、分析、执行和下一步 tool 调用，等待合法 `option.value`；不得把 blocked 当作失败后绕过。
- Elicitation 不可用/失败/取消/拒绝/非法时，必须使用 `menu` 的 WebUI fallback 或等价真实交互控件按 `handoff.options` 渲染并等待选择；assistant 不得用普通文本或 markdown 菜单代替。

## 记忆规则

- 历史事实、项目约定、偏好、决策或上下文必须先用 `mempalace_search` / `mempalace_get_drawer` 核验；写入长期记忆前必须查重，事实变化时更新、删除或失效旧内容。

"""

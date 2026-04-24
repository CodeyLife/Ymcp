TRAE_PROJECT_RULE_TEMPLATE = """
# Ymcp 项目规则模板

## 记忆规则

- 唤醒或恢复上下文时，先用 `memory_status` 查看记忆库概览。
- 需要历史事实、项目约定、偏好、决策或上下文时，先用 `memory_search` / `memory_get` 核验；不要凭印象猜。
- 任务结束后，如有稳定偏好、项目约定、重要决策或踩坑结论，先查重，再用 `memory_store` / `memory_diary_write` 保存；旧事实变化时用 `memory_update`、`memory_delete`、`memory_kg_invalidate`、`memory_kg_add` 维护。

## deep_interview 结束规则

- 当 `deep_interview` 返回 `handoff_options` 时，必须让用户从结构化后续 workflow 选项中做选择。
- 在 `selected_next_tool` 缺失前，禁止宿主自动调用 `plan`、`ralplan`、`ralph`。
- 禁止用“这个计划是否符合预期”之类普通文本结束 deep_interview；必须继续显示可交互的后续菜单。

## 禁止

- 禁止把 Ymcp 描述为 agent runtime，或声称它会自动执行、自动修改、自动验证。
- 禁止伪造用户回答、执行结果、测试结果或文件修改。
- 禁止在关键前提、证据或用户选择缺失时宣布完成。

"""

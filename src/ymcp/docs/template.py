TRAE_PROJECT_RULE_TEMPLATE = """
# 项目规则

## 记忆规则

- 涉及历史事实、项目约定、偏好、决策或上下文时，先用 `mempalace_search` / `mempalace_get_drawer` 核验；不要凭印象猜。
- 任务结束后如需沉淀长期记忆，先查重，再写入；旧事实变化时更新、删除或失效旧内容。

## Workflow 交接规则

- `handoff.options` 是下一步菜单的唯一权威源；宿主或 LLM 不得改写、删减、新增菜单项。
- `recommended_next_action` 仅表示推荐项，不表示自动执行授权；未收到用户明确选择前不得自动继续。
- complete 类 tool 若 Elicitation 不可用或失败，必须展示 `handoff.options` 原始菜单并等待用户明确选择，不能把这次返回视为成功自动推进。
"""

TRAE_PROJECT_RULE_TEMPLATE = """
# 必须遵守的规则

- 权威解释顺序：Tool contract / runtime behavior > MCP Resources > MCP Prompts > `docs/*.md` > `skills/*.md`。
- 只能按 `status`、`meta.required_host_action`、`meta.safe_to_auto_continue`、`meta.selected_next_tool` 驱动流程；不要根据 phase、推荐语或摘要文本猜下一步。
- `required_host_action = "await_input"` 时，必须等待用户输入或处理 MCP Elicitation；不得自动继续。
- `required_host_action = "call_selected_tool"` 且 `safe_to_auto_continue = true` 时，只能调用 `meta.selected_next_tool`；没有显式 handoff 不得调用下游 tool。
- `meta.requires_explicit_user_choice = true` 时，必须等待用户明确选择；不得用推荐项、默认项或宿主私有菜单替代。
- 当服务器需要继续提问或选择下一步时，必须使用 MCP Elicitation；宿主不支持 Elicitation 时，应停止该 workflow，而不是伪造输入或自动代选。
- 在 `selected_next_tool` 缺失前，禁止宿主自动调用 `plan`、`ralplan`、`ralph` 或其他下游 workflow。
- 不得把 Ymcp 描述为 agent runtime，不得声称它会自动执行、自动修改、自动验证。
- 不得伪造用户回答、执行结果、测试结果、文件修改或完成状态。
- 涉及历史事实、项目约定、偏好、决策或上下文时，先用 `mempalace_search` / `mempalace_get_drawer` 核验；不要凭印象猜。
- 任务结束后如需沉淀长期记忆，先查重，再用 `mempalace_add_drawer` / `mempalace_diary_write` 保存；旧事实变化时用 `mempalace_update_drawer`、`mempalace_delete_drawer`、`mempalace_kg_invalidate`、`mempalace_kg_add` 维护一致性。
"""

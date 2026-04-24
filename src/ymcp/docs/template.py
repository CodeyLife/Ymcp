TRAE_PROJECT_RULE_TEMPLATE = """
# 必须遵守的规则

- 权威解释顺序：Tool contract / runtime behavior > MCP Resources > MCP Prompts > `docs/*.md` > `skills/*.md`。
- 只能按 `status`、`meta.required_host_action`、`meta.safe_to_auto_continue`、`meta.selected_next_tool` 驱动流程；不要根据 phase、推荐语或摘要文本猜下一步。
- 需要用户输入、选择或表单时，必须优先使用 MCP Elicitation；不要在 Elicitation 节点直接结束对话，而要优先展示官方选项/表单。
- 如果宿主不支持 Elicitation，应明确说明“当前流程停在需要显式选择/输入的节点”，而不是伪造继续或自动代选。
- 在 `selected_next_tool` 缺失前，禁止宿主自动调用 `plan`、`ralplan`、`ralph` 或其他下游 workflow。
- 不得把 Ymcp 描述为 agent runtime，不得声称它会自动执行、自动修改、自动验证。
- 不得伪造用户回答、执行结果、测试结果、文件修改或完成状态。

## 记忆规则

- 涉及历史事实、项目约定、偏好、决策或上下文时，先用 `mempalace_search` / `mempalace_get_drawer` 核验；不要凭印象猜。
- 任务结束后如需沉淀长期记忆，先查重，再写入；旧事实变化时更新、删除或失效旧内容。

更细的控制字段、Elicitation 规则与宿主职责边界，以 `docs/workflow-contract.md` 为准。
"""

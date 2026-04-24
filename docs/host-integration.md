# 宿主集成

Ymcp 默认使用 stdio 传输，并优先优化 Trae 的 MCP 工具调用体验。

对于长期记忆能力，Ymcp 会进一步通过 `python -m mempalace.mcp_server` 调用 MemPalace 的 MCP 服务；宿主只需要接入 Ymcp，无需再单独实现 MemPalace 的双路径兼容。

推荐的本地服务器配置：

```json
{
  "mcpServers": {
    "ymcp": {
      "command": "ymcp",
      "args": ["serve"],
      "env": {}
    }
  }
}
```

使用 `ymcp print-config --host trae` 可以打印当前配置片段；使用下列命令可以在本地检查 MCP 能力：

```powershell
ymcp inspect-tools --json
ymcp inspect-resources --json
ymcp inspect-prompts --json
ymcp inspect-capabilities --json
```

## 宿主必须遵守的规则

- 权威解释顺序：Tool contract / runtime behavior > MCP Resources > MCP Prompts > `docs/*.md` > `skills/*.md`。
- 宿主只能按 `status`、`meta.required_host_action`、`meta.safe_to_auto_continue`、`meta.selected_next_tool` 驱动流程；不要根据 phase、推荐语或摘要文本猜下一步。
- `required_host_action = "await_input"` 时，必须等待用户输入或处理 MCP Elicitation；不得自动继续。
- `required_host_action = "call_selected_tool"` 且 `safe_to_auto_continue = true` 时，只能调用 `meta.selected_next_tool`；没有显式 handoff 不得调用下游 tool。
- `meta.requires_explicit_user_choice = true` 时，必须等待用户明确选择；不得用推荐项、默认项或宿主私有菜单替代。
- 当服务器需要继续提问或选择下一步时，必须使用 MCP Elicitation；宿主不支持 Elicitation 时，应停止该 workflow，而不是伪造输入或自动代选。
- 在 `selected_next_tool` 缺失前，禁止宿主自动调用 `plan`、`ralplan`、`ralph` 或其他下游 workflow。
- 不得把 Ymcp 描述为 agent runtime，不得声称它会自动执行、自动修改、自动验证。
- 不得伪造用户回答、执行结果、测试结果、文件修改或完成状态。
- 涉及历史事实、项目约定、偏好、决策或上下文时，先用 `mempalace_search` / `mempalace_get_drawer` 核验；不要凭印象猜。
- 任务结束后如需沉淀长期记忆，先查重，再用 `mempalace_add_drawer` / `mempalace_diary_write` 保存；旧事实变化时用 `mempalace_update_drawer`、`mempalace_delete_drawer`、`mempalace_kg_invalidate`、`mempalace_kg_add` 维护一致性。

## LLM 宿主系统提示模板

```text
你正在使用 Ymcp 作为 MCP workflow 工具服务器。

一切流程优先遵守 MCP 官方标准能力：
- 用户输入、选择和表单交互优先使用 MCP Elicitation。
- 工具输出优先消费标准 structuredContent / outputSchema。
- 不要再定义或依赖宿主私有 workflow 协议。

如果客户端支持 Elicitation，必须优先处理服务器发出的表单/选择请求。
如果客户端不支持 Elicitation，或其 UI 渲染不完整，不要伪造用户输入，也不要自动选择推荐项；该宿主不应继续 workflow 交互。

涉及历史事实、项目约定、偏好或上下文时，先调用 mempalace_search / mempalace_get_drawer。

不得把 Ymcp 描述为 agent runtime，不得伪造用户回答、执行结果、测试结果或文件修改。
```

更多字段语义见 `docs/workflow-contract.md`；逐工具宿主实现步骤见 `docs/host-implementation-guide.md`。

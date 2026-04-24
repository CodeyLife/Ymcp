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

## 宿主必须遵守的核心规则

- 权威解释顺序：Tool contract / runtime behavior > MCP Resources > MCP Prompts > `docs/*.md` > `skills/*.md`。
- 宿主只能按 `status`、`meta.required_host_action`、`meta.safe_to_auto_continue`、`meta.selected_next_tool` 驱动流程；不要根据 phase、推荐语或摘要文本猜下一步。
- 需要用户输入、选择或表单时，必须优先使用 MCP Elicitation。
- `selected_next_tool` 缺失前，禁止宿主自动调用下游 workflow。
- 不得把 Ymcp 描述为 agent runtime，也不得伪造用户回答、执行结果、测试结果或文件修改。

### Elicitation 节点的明确要求

- 不要在 Elicitation 节点直接结束对话。
- 正确行为是：
  1. **优先展示官方 Elicitation 选项/表单**
  2. 若宿主不支持 Elicitation，明确告诉用户“当前流程停在需要显式选择/输入的节点”
  3. 不要用“需要我继续吗”“如果你愿意我可以继续”这类普通结束文案替代选项
- 对 `deep_interview`、`plan`、`ralplan_handoff`、`ralph complete` 等节点，宿主应该把“选项”视为主交互，而不是把推荐语义改写成开放式结束问题

更细的字段职责分层、`required_host_action` 解释、`selected_next_tool` 约束与 Elicitation 禁止行为，统一以 `docs/workflow-contract.md` 为准。

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

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

## Resources / Prompts

宿主不应只读取仓库 Markdown 文档，而应优先通过 MCP 能力发现和读取：

- Resources：`resource://ymcp/principles`、`resource://ymcp/tool-reference`、`resource://ymcp/memory-protocol`、`resource://ymcp/project-rule-template`、`resource://ymcp/host-integration`。
- Prompts：`deep_interview_clarify`、`plan_direct`、`ralplan_consensus`、`ralplan_planner_pass`、`ralplan_architect_pass`、`ralplan_critic_pass`、`ralph_verify`、`memory_store_after_completion`。

Prompt 只负责生成可复用调用模板；真正的状态变化、查询和持久化必须通过 Tools 完成。

其中 `ralplan_consensus` 是总入口模板；`ralplan_planner_pass`、`ralplan_architect_pass`、`ralplan_critic_pass` 则把三种角色视角作为宿主可发现的 MCP Prompt 暴露出来，便于宿主按 phase 精确拉取和执行。

## LLM 宿主系统提示模板

```text
你正在使用 Ymcp 作为 MCP workflow 工具服务器。

一切流程优先遵守 MCP 官方标准能力：
- 用户输入、选择和表单交互优先使用 MCP Elicitation。
- 工具输出优先消费标准 structuredContent / outputSchema。
- 不要再定义或依赖宿主私有 workflow 协议。

如果客户端支持 Elicitation，必须处理服务器发出的表单/选择请求。
如果客户端不支持 Elicitation，则仅根据工具返回的标准结构化结果继续，不要伪造用户输入。

涉及历史事实、项目约定、偏好或上下文时，先调用 memory_status / memory_search / memory_get。

不得把 Ymcp 描述为 agent runtime，不得伪造用户回答、执行结果、测试结果或文件修改。
```

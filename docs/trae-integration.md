# Trae 集成

Ymcp 设计为可被 Trae 作为本地 MCP stdio 服务器调用。

## 1. 安装

```powershell
pip install ymcp
pip install -U ymcp
```

开发环境安装：

```powershell
python -m pip install -e .[dev]
```

## 2. 检查本地环境

```powershell
ymcp doctor
ymcp inspect-tools --json
ymcp call-fixture plan --json
```

`ymcp doctor` 会输出 Python、依赖包和命令路径信息。Trae 无法启动服务器时，优先查看这条命令的结果。

## 3. 在 Trae 中添加 Ymcp

打开 Trae 的 MCP 设置，添加本地 MCP 服务器。配置片段可由以下命令生成：

```powershell
ymcp print-config --host trae
```

默认配置：

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

## 4. 一键初始化 Trae

推荐直接运行：

```powershell
ymcp init-trae
```

## 5. 预期工具

Trae 应该能发现以下四个工具：

- `plan`
- `ralplan`
- `deep_interview`
- `ralph`

## 6. Trae 调用示例

- 调用 Ymcp 的 `plan` 工具，为当前任务返回阶段计划和验收标准。
- 调用 Ymcp 的 `deep_interview` 工具，通过 MCP Elicitation 收集澄清回答。
- 调用 Ymcp 的 `ralplan` 工具，总结方案选项、推荐方案、ADR 和测试策略。
- 调用 Ymcp 的 `ralph` 工具，根据当前证据判断下一步是继续还是验证。

## 7. 宿主边界

Ymcp 不执行命令、不 spawn agent、不修改文件、不持久化循环。用户输入、选择与表单交互优先通过 MCP 官方 Elicitation 完成；若客户端不支持 Elicitation，则工具只返回标准结构化结果和缺失输入说明。

## 8. 故障排查

- 工具不可见：运行 `ymcp inspect-tools --json`。
- 服务器无法启动：运行 `ymcp doctor --json`。
- PATH 问题：在 Trae 配置中使用 `ymcp.exe` 的绝对路径。
- 协议问题：保持 `ymcp serve` 使用 stdio，不要把人类可读日志输出到 stdout。

## 9. 记忆工具使用指南

Ymcp 的记忆工具基于 MemPalace。默认使用 `~/.yjj` 作为记忆库目录，并写入全局个人记忆空间：`wing="personal"`、`room="ymcp"`。

当前记忆接入已经统一为 MCP-only：

- Ymcp 通过 `python -m mempalace.mcp_server` 与 MemPalace 通信
- 所有 `memory_*` 工具都经由 MemPalace MCP tool 调用完成

### Memory Protocol（建议宿主纳入固定协议）

1. **唤醒时先看总览**：进入工作流、恢复历史任务或切换上下文时，先调用 `memory_status`。
2. **回答过去事实前先查**：先调用 `memory_search` / `memory_get` / 图谱工具核验。
3. **不确定就明确说要查**：不确定时先说明需要查询记忆。
4. **结束后写回**：稳定偏好、项目约定、重要决策和踩坑结论通过 `memory_store` 或 `memory_diary_write` 沉淀。
5. **事实变化要维护**：用 `memory_update` / `memory_delete` / `memory_kg_invalidate` 清理或失效旧内容，再补写新事实。

### Trae 可复制 prompt 示例

#### 保存用户偏好

```text
调用 Ymcp 的 memory_store 工具，保存这条长期偏好：
“用户要求：回复和项目文档都优先使用中文；代码符号、协议字段和命令名保持英文。”
```

#### 查询历史记忆

```text
调用 Ymcp 的 memory_search 工具，搜索关键词：“Ymcp PyPI 发布流程”。
```

#### 先查再写

```text
先调用 Ymcp 的 memory_search 搜索：“Trae MCP 配置 init-trae”。
如果没有相同或高度相似记忆，再调用 memory_store 保存当前结论。
```

#### 记忆写入安全提醒

记忆写入是持久化副作用。Trae 调用 `memory_store`、`memory_update`、`memory_delete`、`memory_kg_add`、`memory_diary_write` 等工具前，应确认内容适合长期保存。遇到密钥、隐私、未经确认的事实，应先询问用户。

## 工作流状态机投影

Ymcp 会把 workflow 当前阶段与结构化结果投影给客户端。Trae 宿主负责循环、提问、执行命令、保存状态和展示结果。

宿主应优先使用 MCP 官方能力：

- 用户输入、选择和表单交互优先使用 **Elicitation**
- 工具结果优先消费标准结构化 output / structuredContent
- 不要再依赖自定义 `interaction` / `continuation` 作为主协议

### workflow_state

- `workflow_name`
- `current_phase`
- `readiness`
- `evidence_gaps`
- `blocked_reason`
- `skill_source`
- `memory_preflight`

## 12. Workflow 最佳调用链

### 链路 A：需求不清晰 → 规划 → 执行验证

1. 调用 `deep_interview`。
2. 由服务器通过 Elicitation 收集回答，或在不支持 Elicitation 时返回标准 `needs_input`。
3. 当需求达到可结晶状态时，进入 `ralplan`。
4. `ralplan` 按 `planner_draft → architect_review → critic_review` 顺序推进。
5. 批准后进入 `ralph` 或由用户选择 `plan / memory_store`。
6. `ralph` 根据证据返回继续、修复或完成状态。
7. 完成后调用 `memory_store` 保存稳定偏好、项目约定或踩坑结论。

### 链路 B：需求已清楚 → 直接计划 → Ralph 循环

1. 调用 `plan`，传入 `mode="direct"`。
2. 如需用户选择下一步，优先通过 Elicitation 获取。
3. 每轮执行后调用 `ralph`，传入 `latest_evidence` 和 `verification_commands`。

### 链路 C：高风险或架构选择 → Ralplan 共识

1. 调用 `ralplan`，`current_phase="planner_draft"`。
2. 按顺序推进 Architect / Critic 反馈。
3. 批准后通过 Elicitation 或标准降级结果决定进入 `ralph`、`plan` 或 `memory_store`。

### 链路 D：长期偏好和项目知识沉淀

1. 调用 `memory_search` 搜索是否已有相似记忆。
2. 没有重复时调用 `memory_store` 保存稳定事实。
3. 如已有但过期，先 `memory_get` 再 `memory_update`。
4. 如发现错误或敏感信息，调用 `memory_delete` 删除。

## 13. Workflow 专用 Trae Prompt 模板

### deep_interview 多轮澄清模板

```text
调用 Ymcp 的 deep_interview。
如果客户端支持 MCP Elicitation，请直接处理 elicitation；
否则根据标准 structured result 中的 requested_input 再继续。
```

### plan 直接规划模板

```text
调用 Ymcp 的 plan。
输入：task、constraints、acceptance_criteria。
如果需要用户选择下一步，优先使用 MCP Elicitation。
```

### ralplan Planner 阶段模板

```text
调用 Ymcp 的 ralplan。
输入：task, current_phase="planner_draft"。
读取 principles、decision_drivers、viable_options 和 ADR 草案，再继续 Architect 审查。
```

### ralplan Architect → Critic 阶段模板

```text
调用 Ymcp 的 ralplan。
按 architect_review → critic_review 顺序推进，并把反馈回传给工具。
```

### ralph 执行验证模板

```text
调用 Ymcp 的 ralph。
输入：approved_plan、latest_evidence、verification_commands。
如果缺失用户输入，优先通过 Elicitation 补齐。
```

### 完成后记忆沉淀模板

```text
任务完成后，先调用 Ymcp 的 memory_search。
如果没有重复记忆，再调用 memory_store 保存稳定事实。
```

## 14. 工作流开始前读取记忆

在调用 `deep_interview`、`plan`、`ralplan` 前，Trae 应优先根据当前需求调用 `memory_search` 读取相关长期记忆。

工具返回的 `workflow_state.memory_preflight` 会提示是否需要读取记忆：

- `required=true`
- `query`
- `already_satisfied=true`

结构化方式示例：

```json
{
  "memory_context": {
    "searched": true,
    "hits": ["Ymcp 的 Trae 配置使用 ymcp serve"],
    "failed": false,
    "query": "Ymcp Trae workflow 状态机"
  }
}
```

旧版宿主也可以传 `known_context` 文本摘要；新宿主优先使用结构化 `memory_context`。

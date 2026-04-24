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

Trae 应该能发现以下 workflow 工具：

- `plan`
- `ralplan`
- `ralplan_planner`
- `ralplan_architect`
- `ralplan_critic`
- `ralplan_handoff`
- `deep_interview`
- `ralph`

## 6. Trae 调用示例

- 调用 Ymcp 的 `plan` 工具，为当前任务返回阶段计划、`plan_markdown_draft`、验收标准和验证计划。
- 调用 Ymcp 的 `deep_interview` 工具，通过 MCP Elicitation 收集澄清回答。
- `deep_interview` 结果中的 `context_snapshot_draft`、`execution_spec`、`handoff_contracts` 由宿主决定是否落盘；Ymcp 只返回结构化草稿，不直接写 `.omx/*` 文件。
- 调用 Ymcp 的 `ralplan` 工具，获取共识流总入口；再按 `selected_next_tool` 顺序调用 `ralplan_planner`、`ralplan_architect`、`ralplan_critic`、`ralplan_handoff`，并消费其结构化 RALPLAN-DR / ADR / handoff guidance 产物。
- 调用 Ymcp 的 `ralph` 工具，根据当前证据、completion gates 和验证结果判断下一步是继续、修复还是完成；`execution_context_present` 用来表达是否已提供足够执行上下文；`ralph` 本身不执行任务。

## 7. 宿主边界

Ymcp 不执行命令、不 spawn agent、不修改文件、不持久化循环。用户输入、选择与表单交互优先通过 MCP 官方 Elicitation 完成；若客户端不支持 Elicitation，则工具只返回标准结构化结果和缺失输入说明。

如果当前 workflow 节点依赖显式用户选择，Trae 应停止 workflow 交互，而不是改用私有菜单协议或自动代选推荐项。

## 8. 故障排查

- 工具不可见：运行 `ymcp inspect-tools --json`。
- 服务器无法启动：运行 `ymcp doctor --json`。
- PATH 问题：在 Trae 配置中使用 `ymcp.exe` 的绝对路径。
- 协议问题：保持 `ymcp serve` 使用 stdio，不要把人类可读日志输出到 stdout。

## 9. 记忆工具使用指南

Ymcp 的记忆工具基于 MemPalace。默认使用 `~/.yjj` 作为记忆库目录。记忆 wing 采用项目感知解析链：显式 `wing` → `project_id` → `project_root` 目录名 slug → `YMCP_DEFAULT_WING` → `personal`；默认 `room="ymcp"`。

当前记忆接入已经统一为 MCP-only：

- Ymcp 通过 `python -m mempalace.mcp_server` 与 MemPalace 通信
- 所有 `memory_*` 工具都经由 MemPalace MCP tool 调用完成

推荐宿主在记忆工具调用时统一补充：

- `project_id`：稳定项目 ID，优先决定 wing
- `project_root`：当前工程根目录，作为 `project_id` 缺失时的回退来源

如果宿主不传任何项目上下文，Ymcp 才会回退到 `personal`。

### Memory Protocol（建议宿主纳入固定协议）

1. **回答过去事实前先查**：先调用 `mempalace_search` / `mempalace_get_drawer` / 图谱工具核验。
2. **不确定就明确说要查**：不确定时先说明需要查询记忆。
3. **结束后写回**：稳定偏好、项目约定、重要决策和踩坑结论通过 `mempalace_add_drawer` 或 `mempalace_diary_write` 沉淀。
4. **事实变化要维护**：用 `mempalace_update_drawer` / `mempalace_delete_drawer` / `mempalace_kg_invalidate` 清理或失效旧内容，再补写新事实。

### Trae 可复制 prompt 示例

#### 保存用户偏好

```text
调用 Ymcp 的 mempalace_add_drawer 工具，保存这条长期偏好：
“用户要求：回复和项目文档都优先使用中文；代码符号、协议字段和命令名保持英文。”
```

#### 查询历史记忆

```text
调用 Ymcp 的 mempalace_search 工具，搜索关键词：“Ymcp PyPI 发布流程”。
```

#### 先查再写

```text
先调用 Ymcp 的 mempalace_search 搜索：“Trae MCP 配置 init-trae”。
如果没有相同或高度相似记忆，再调用 mempalace_add_drawer 保存当前结论。
```

#### 记忆写入安全提醒

记忆写入是持久化副作用。Trae 调用 `mempalace_add_drawer`、`mempalace_update_drawer`、`mempalace_delete_drawer`、`mempalace_kg_add`、`mempalace_diary_write` 等工具前，应确认内容适合长期保存。遇到密钥、隐私、未经确认的事实，应先询问用户。

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

### artifacts 中的展示字段

- `phase_summary`
- `selected_next_tool`（仅在 Elicitation 已接受后出现）
- `plan_markdown_draft` / `review_verdict`
- `approved_plan_markdown` / `adr` / `ralph_handoff_guidance`
- `completion_gates` / `verification_summary`

`selected_next_tool` 的含义是：**用户已经通过服务器发起的 Elicitation 显式完成选择**。Trae 不得把推荐项、默认项或 phase 推断结果当成 `selected_next_tool`。

### 展示要求

当宿主支持 MCP Elicitation 时，优先处理服务器发起的表单/单选请求；如果 UI 渲染不完整，也不要改成宿主私有菜单或自动选择默认项：

- `phase_summary`：当前阶段的人类可读摘要与 highlights
- `selected_next_tool`：仅当服务器发起的 Elicitation 被接受后才会出现

也就是说，宿主不应自己渲染私有菜单、猜测默认项、自动继续，或把推荐语义重新包装成普通文本问题。

## 12. Workflow 最佳调用链

### 链路 A：需求不清晰 → 规划 → 执行验证

1. 调用 `deep_interview`。
2. 由服务器通过 Elicitation 收集回答；不支持 Elicitation 的宿主不应继续该 workflow。
3. 如果 `workflow_state.readiness == "needs_host_context"`，宿主应先补 `repo_findings` / `known_context`，不要改成向用户追问代码库内部事实。
4. 当需求达到可结晶状态时，进入 `ralplan`。
5. `ralplan` 先返回总入口 handoff；Trae 再按 `ralplan_planner → ralplan_architect → ralplan_critic → ralplan_handoff` 顺序推进。
6. 批准后进入 `ralph` 或由用户选择 `plan / mempalace_add_drawer`。
7. `ralph` 根据证据返回继续、修复或完成状态；真正的执行、修复、验证命令仍由 Trae 或其上层 agent 执行。
8. 完成后调用 `mempalace_add_drawer` 保存稳定偏好、项目约定或踩坑结论。

### 链路 B：需求已清楚 → 直接计划 → Ralph 循环

1. 调用 `plan`，传入 `mode="direct"`。
2. 如需用户选择下一步，优先通过 Elicitation 获取。
3. 每轮执行后调用 `ralph`，传入 `latest_evidence`、`verification_commands`，以及可用时的 `verification_results` / `regression_status`。

### 链路 C：高风险或架构选择 → Ralplan 共识

1. 调用 `ralplan` 总入口。
2. 按 `selected_next_tool` 顺序调用 `ralplan_planner`、`ralplan_architect`、`ralplan_critic`。
3. `ralplan_critic` 批准后再调用 `ralplan_handoff`，消费 `approved_plan_markdown`、`adr`、`ralph_handoff_guidance`，并只通过 Elicitation 决定进入 `ralph`、`plan` 或 `mempalace_add_drawer`。

### 链路 D：长期偏好和项目知识沉淀

1. 调用 `mempalace_search` 搜索是否已有相似记忆。
2. 没有重复时调用 `mempalace_add_drawer` 保存稳定事实。
3. 如已有但过期，先 `mempalace_get_drawer` 再 `mempalace_update_drawer`。
4. 如发现错误或敏感信息，调用 `mempalace_delete_drawer` 删除。

## 13. Workflow 专用 Trae Prompt 模板

### deep_interview 多轮澄清模板

```text
调用 Ymcp 的 deep_interview。
如果客户端支持 MCP Elicitation，请直接处理 elicitation；
如果客户端不支持或未正确渲染 Elicitation，应停止 workflow 交互；不要改用宿主私有交互协议。
```

### plan 直接规划模板

```text
调用 Ymcp 的 plan。
输入：task、constraints、acceptance_criteria。
如果需要用户选择下一步，优先使用 MCP Elicitation。
```

### ralplan Planner 阶段模板

```text
先调用 Ymcp 的 ralplan。
再按返回的 `selected_next_tool` 调用 `ralplan_planner`。
Planner 结果会直接包含结构化规划草案、方案选项和 ADR 草案。
```

### ralplan Architect → Critic 阶段模板

```text
按 `selected_next_tool` 顺序调用 `ralplan_architect` 与 `ralplan_critic`。
不要跳过子工具，也不要根据 phase 名称猜下一步。
```

### ralph 执行验证模板

```text
调用 Ymcp 的 ralph。
输入：approved_plan、latest_evidence、verification_commands。
如果缺失用户输入，优先通过 Elicitation 补齐。不要把 ralph 当作执行器；它只对真实证据做 continue/fix/complete 判断。
```

### 完成后记忆沉淀模板

```text
任务完成后，先调用 Ymcp 的 mempalace_search。
如果没有重复记忆，再调用 mempalace_add_drawer 保存稳定事实。
```

## 14. 工作流开始前读取记忆

在调用 `deep_interview`、`plan`、`ralplan` 前，Trae 应优先根据当前需求调用 `mempalace_search` 读取相关长期记忆。

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

更多协议细节见 `docs/workflow-contract.md`，逐工具实现指南见 `docs/host-implementation-guide.md`。

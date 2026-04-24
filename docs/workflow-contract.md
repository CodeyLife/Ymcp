# Ymcp Workflow Contract

## 1. Ymcp 与宿主的职责边界

### Ymcp 负责

- 暴露 MCP **Tools / Resources / Prompts**
- 返回标准结构化结果与 workflow 状态投影
- 在需要用户输入或选择时发起 **MCP Elicitation**
- 暴露 `workflow_state`、`phase_summary`、`memory_preflight`、`selected_next_tool`

### 宿主负责

- 循环控制
- 展示结果
- 真正执行命令、调用外部系统、保存本地状态
- 在同一宿主上下文中推动 Planner / Architect / Critic 等 phase pass
- 根据 `status` 与 `meta.required_host_action` 决定下一步

### Ymcp 不负责

- 不执行 shell / build / test
- 不 spawn agent
- 不修改文件
- 不持久化执行循环
- 不伪造用户输入、测试结果或执行结果

## 3. 核心控制字段

所有 workflow tool 都会返回 `status`、`meta` 与 `artifacts.workflow_state`。

### `status`

- `ok`：当前 phase 结构化结果可被消费
- `needs_input`：继续前还需要用户输入、证据或反馈
- `blocked`：因能力缺失或关键前提缺失而不能继续
- `error`：工具内部错误

### `meta.required_host_action`

- `display_only`：只展示结果，不自动调用下游 tool
- `await_input`：等待用户输入或处理 MCP Elicitation
- `call_selected_tool`：只调用 `meta.selected_next_tool`
- `continue_execution`：继续当前执行/验证分支，不代表切换 workflow
- `stop` / `finish`：停止或结束当前流程

### `meta.selected_next_tool`

仅当服务器发起的 Elicitation 被 **用户显式接受** 后才会出现。\
宿主不得把推荐项、默认项或 phase 名称当作 `selected_next_tool`。

### `artifacts.workflow_state`

这是 **状态机投影**，用于展示、日志和宿主控制，不是“Ymcp 正在内部执行任务”的证明。

常见字段：

- `workflow_name`
- `current_phase`
- `readiness`
- `evidence_gaps`
- `blocked_reason`
- `skill_source`
- `memory_preflight`

## 4. Elicitation 规则

### 必须使用 Elicitation 的场景

- `deep_interview` 多轮问答
- plan / ralplan / ralph 的下一步 workflow 选择
- `ralph` 缺 `latest_evidence` 或 `verification_commands` 时补齐输入

### 宿主禁止行为

- 不要伪造用户输入
- 不要自动接受推荐项
- 不要把选择题降级成宿主私有菜单协议
- 不要在 `selected_next_tool` 缺失时猜测下一个 workflow

### 不支持 Elicitation 时

- 宿主可以展示当前结构化结果
- 但 **不得伪造 workflow 继续所需的用户选择**
- 对明确依赖用户选择的节点，应视为 workflow 交互无法继续

## 5. Tool 语义澄清

### `deep_interview`

- 用于澄清需求、边界、非目标、决策边界
- 返回的是 **需求结晶状态**，不是自动执行后续 workflow
- 当 `selected_next_tool` 为空时，宿主不得自动跳到 `plan` / `ralplan` / `ralph`

### `plan`

- 生成直接计划或判断任务是否过于模糊
- `mode="auto"` 可能转入澄清路径
- 它返回的是结构化计划结果，不执行实现

### `ralplan`

- 是 **共识规划状态机**
- Ymcp 不会替宿主自动完成 Planner / Architect / Critic 三个写作 pass
- 宿主必须按 `planner_draft → architect_review → critic_review` 顺序推进，并将真实结果回传

### `ralph`

- 是 **证据驱动的执行闭环判断工具**
- 它不执行任务本身
- 它根据 `approved_plan`、`latest_evidence`、`verification_commands`、`known_failures` 判断：
  - 继续执行
  - 先修复
  - 需要更多证据
  - 需要验证计划
  - 已完成

## 6. `memory_preflight` 语义

`memory_preflight` 用来提示宿主是否应在 workflow 开始前先读取长期记忆。

- `required=true`：建议优先先查记忆再继续
- `query`：推荐搜索词
- `already_satisfied=true`：宿主已提供足够上下文，可直接继续
- `search_performed=true`：宿主或上游已完成检索

它默认是 **前置建议/约束提示**，不是“Ymcp 已自动完成记忆读取”的表示。

## 7. 推荐时序

### 模糊需求

`deep_interview → ralplan → ralph → mempalace_add_drawer`

### 已明确任务

`plan(mode="direct") → ralph`

### 高风险/架构型任务

`ralplan(planner_draft → architect_review → critic_review) → ralph`

### 经验沉淀

`mempalace_search → mempalace_add_drawer`

## 8. 实施原则

- 宿主优先读 Tool contract 与 MCP Resource，不要只读仓库 Markdown
- 任何自动继续都必须建立在 `meta.required_host_action` 明确允许的前提上
- `current_phase` 适合展示，不应替代 `required_host_action`
- 需要历史事实、约定、偏好时先查 MemPalace，再作答


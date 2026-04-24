# Ymcp Host Implementation Guide

这是一份面向宿主工程师的最小实现手册，重点回答：**每个 workflow tool 返回后，宿主到底要做什么。**

## 1. 通用宿主循环

1. 调用 Ymcp tool
2. 读取 `status`
3. 读取 `meta.required_host_action`
4. 展示 `artifacts.phase_summary`
5. 如需用户输入，仅通过 MCP Elicitation 继续
6. 如 `meta.selected_next_tool` 已写回，再调用该 tool

不要只根据 `current_phase` 猜测控制流。字段职责分层（`summary` / `phase_summary` / `workflow_state` / `artifacts`）统一以 `docs/workflow-contract.md` 为准。

如果当前节点依赖显式用户选择：

- **不要在 Elicitation 节点直接结束对话**
- 应优先展示服务器要求的 Elicitation 选项
- 若宿主不支持 Elicitation，应明确说明“当前流程停在需要显式选择/输入的节点”，而不是改写成普通结束文案

其余 Elicitation 禁止行为与控制字段规则不要在此重复展开，统一遵循 `docs/workflow-contract.md` 和 `docs/host-integration.md`。

## 2. 通用字段速查

| 字段 | 宿主如何使用 |
| --- | --- |
| `status` | 判断当前是否还能继续 |
| `meta.required_host_action` | 决定展示、等待输入、继续执行还是调用下游 tool |
| `meta.selected_next_tool` | 仅在用户显式选择后自动 handoff |
| `artifacts.phase_summary` | 展示给用户/日志 |
| `artifacts.workflow_state` | 记录 workflow 名称、phase、readiness、证据缺口 |
| `workflow_state.memory_preflight` | 决定是否先调 `mempalace_search` |

这里只保留“怎么用”的速查，不重复定义字段规范本身。

## 3. 每个 Tool 的宿主义务

## `deep_interview`

### Ymcp 返回什么

- 当前歧义分数
- 最弱维度
- 下一问
- readiness gates
- 结晶后的 `spec_skeleton`

### 宿主要做什么

- 如果返回下一问，处理服务器发起的 Elicitation
- 接受回答后，把答案继续交给同一个 `deep_interview` 会话
- 如果出现 `selected_next_tool`，按其值 handoff

### 宿主不要做什么

- 不要在没有 `selected_next_tool` 时自行跳转到 `plan` / `ralplan` / `ralph`
- 不要把推荐 workflow 当成最终选择

## `plan`

### Ymcp 返回什么

- 直接计划、review 结果，或“任务过于模糊”的判断

### 宿主要做什么

- `interview_required`：让用户通过 Elicitation 选择继续澄清或补充细节
- `direct_plan`：展示计划，并等待下一步 workflow 选择
- `review`：如缺 `review_target`，补齐输入

### 宿主不要做什么

- 不要把 `plan` 当执行器
- 不要在 `direct_plan` 阶段自动进入 `ralph`

## `ralplan`

### Ymcp 返回什么

- 候选方案、原则、决策驱动因素、ADR 草案
- 当前 phase 所需的 `planner/architect/critic` prompt ref
- 批准态的 handoff 提示

### 宿主要做什么

按顺序推进：

1. `planner_draft`
2. `architect_review`
3. `critic_review`
4. 如需修订则闭环重来
5. 批准后等待下一工具选择

### 责任矩阵

| phase | Ymcp 做什么 | 宿主做什么 |
| --- | --- | --- |
| `planner_draft` | 返回规划框架与 prompt ref | 生成/收集 planner draft，并回传 |
| `architect_review` | 返回 architect 审查提示 | 完成 architect pass，并回传反馈 |
| `critic_review` | 返回 critic 审查提示 | 完成 critic pass，并回传 verdict/feedback |
| `approved` / `handoff_to_ralph` | 返回批准态 | 通过 Elicitation 决定 `ralph` / `plan` / `mempalace_add_drawer` |

### 宿主不要做什么

- 不要假设 Ymcp 已内部运行 Planner / Architect / Critic
- 不要跳过 architect 直接 critic

## `ralph`

### Ymcp 返回什么

- `stop_continue_judgement`
- `verification_checklist`
- 缺失证据
- 可沉淀的记忆候选

### 宿主要做什么

- `needs_more_evidence`：补 `latest_evidence`
- `needs_verification_plan`：补 `verification_commands`
- `fixing`：先修复已知失败，再重新验证
- `continue`：继续当前执行/验证分支
- `complete`：等待用户决定 finish / re-plan / memory store

### 宿主不要做什么

- 不要把 `ralph` 当成执行器
- 不要在没有真实证据时让 `ralph` 判定完成

## 4. 典型时序

## A. 模糊需求到执行

1. 调 `deep_interview`
2. 处理 Elicitation 问答
3. 用户选择 `ralplan`
4. 宿主驱动 `planner_draft → architect_review → critic_review`
5. 批准后用户选择 `ralph`
6. 宿主执行实现/验证动作，并把证据送入 `ralph`
7. 完成后用户选择 `mempalace_add_drawer` 或 `finish`

## B. 明确任务快速推进

1. 调 `plan(mode="direct")`
2. 展示计划
3. 用户选择 `ralph`
4. 宿主执行实现/验证
5. 调 `ralph` 做闭环判断

## 5. 无 Elicitation 时的行为

可以做：

- 展示结构化结果
- 记录 phase、风险、证据缺口

不可以做：

- 伪造用户回答
- 自动选推荐项
- 用宿主私有菜单替代 Ymcp 的 workflow 选择协议

如果当前节点依赖显式选择，则应视为 **workflow 无法继续交互**。

## 6. 最低实现建议

宿主至少应支持：

- MCP Tool 调用
- MCP Resource 读取
- MCP Prompt 读取
- MCP Elicitation（表单/单选）
- `status` / `meta.required_host_action` 驱动控制流

若不支持 Elicitation，可只消费只读结果，不应实现完整 workflow 交互。

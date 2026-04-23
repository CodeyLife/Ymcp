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

如果 Trae 找不到 `ymcp`，请把 `command` 替换为 Python Scripts 目录或虚拟环境中的 `ymcp.exe` 绝对路径。



## 4. 一键初始化 Trae

推荐直接运行：

```powershell
ymcp init-trae
```

该命令会执行三步：

1. 检查 `~/.yjj` 是否存在；如果不存在，则自动初始化 MemPalace，并把该目录配置为默认记忆库目录
2. 创建或更新当前 Windows 用户的 Trae CN 用户级 MCP 配置：`C:\Users\{用户}\AppData\Roaming\Trae CN\User\mcp.json`
3. 询问是否在当前项目 `.trae/rules/` 下创建 Ymcp 项目规则

非交互场景可使用：

```powershell
ymcp init-trae --yes-project-rules
ymcp init-trae --no-project-rules
```

项目规则范本位于：`docs/trae-project-rule-template.md`。

初始化完成后，可通过 `ymcp doctor --json` 查看 `mempalace.palace_path` 是否已指向 `~/.yjj`。

## 5. 预期工具

Trae 应该能发现以下四个工具：

- `plan`
- `ralplan`
- `deep_interview`
- `ralph`

## 6. Trae 调用示例

- 调用 Ymcp 的 `plan` 工具，为当前任务返回阶段计划和验收标准。
- 调用 Ymcp 的 `deep_interview` 工具，并把它建议的下一问展示给我。
- 调用 Ymcp 的 `ralplan` 工具，总结方案选项、推荐方案、ADR 和测试策略。
- 调用 Ymcp 的 `ralph` 工具，根据当前证据判断下一步是继续还是验证。

## 7. 宿主边界

Ymcp 不执行命令、不 spawn agent、不修改文件、不持久化循环，也不会直接询问用户。Trae 拥有交互循环，并决定如何使用 Ymcp 返回的结构化指导。

## 8. 故障排查

- 工具不可见：运行 `ymcp inspect-tools --json`，确认本地能看到四个标准工具名。
- 服务器无法启动：运行 `ymcp doctor --json`，检查 Python 路径和依赖版本。
- PATH 问题：在 Trae 配置中使用 `ymcp.exe` 的绝对路径。
- 协议问题：保持 `ymcp serve` 使用 stdio，不要把人类可读日志输出到 stdout。


## 9. 记忆工具使用指南

Ymcp 的记忆工具基于 MemPalace。默认使用 `~/.yjj` 作为记忆库目录，并写入全局个人记忆空间：`wing="personal"`、`room="ymcp"`。

### Memory Protocol（建议宿主纳入固定协议）

为避免“把存储当记忆直接复述”，建议宿主把下面这组行为规则固定到提示词或项目规则中：

1. **唤醒时先看总览**：进入工作流、恢复历史任务或切换上下文时，先调用 `memory_status` 读取当前记忆库概览。
2. **回答过去事实前先查**：涉及人物、项目、历史事件、过往决策或“之前怎么做的”时，先调用 `memory_search` / `memory_get` / 图谱工具核验，不要直接猜。
3. **不确定就明确说要查**：如果对记忆事实没有把握，应先说明“我先查一下记忆”，再调用相关工具。
4. **结束后写回**：每次任务或会话结束后，把稳定偏好、项目约定、重要决策、踩坑结论等内容通过 `memory_store` 或 `memory_diary_write` 沉淀下来。
5. **事实变化要维护**：旧事实失效时，优先用 `memory_update` / `memory_delete` / `memory_kg_invalidate` 清理或失效旧内容，再补写新事实。

这套协议的核心目标是：**先核验，再作答；先维护，再复用。**

### 推荐使用流程

1. **先查再写**：不确定是否已有相关记忆时，先调用 `memory_search`。
2. **确认有价值再保存**：只把稳定偏好、项目约定、重要决策、踩坑结论写入 `memory_store`。
3. **需要引用原文时读取**：搜索结果包含 `drawer_id` 时，用 `memory_get` 读取完整内容。
4. **记忆过期时维护**：用 `memory_update` 修正旧记忆，用 `memory_delete` 删除错误或敏感记忆。
5. **定期检查状态**：用 `memory_status` 查看当前记忆库状态。

### 适合保存的内容

- 用户长期偏好，例如“我希望回复和文档都使用中文”。
- 项目稳定约定，例如“Ymcp 的 Trae 配置使用 `ymcp serve`”。
- 架构决策，例如“Ymcp MCP server 不做 agent runtime，只提供工具”。
- 发布流程和踩坑结论，例如“发布前必须先跑 TestPyPI”。

### 不建议保存的内容

- 密码、token、cookie、私钥等敏感信息。
- 一次性临时日志或无长期价值的构建输出。
- 未经用户确认的隐私信息。
- 仍在争论中的猜测或未验证结论。

## 10. Trae 可复制 prompt 示例

### 保存用户偏好

```text
调用 Ymcp 的 memory_store 工具，保存这条长期偏好：
“用户要求：回复和项目文档都优先使用中文；代码符号、协议字段和命令名保持英文。”
默认写入 personal/ymcp。
```

### 保存项目约定

```text
调用 Ymcp 的 memory_store 工具，保存这条项目约定：
“Ymcp 是 Trae 优先的 MCP 工具包，提供 workflow tools 和 MemPalace 长期记忆工具；MCP server 不执行命令、不充当 agent runtime。”
```

### 查询历史记忆

```text
调用 Ymcp 的 memory_search 工具，搜索关键词：“Ymcp PyPI 发布流程”。
请只总结和当前任务相关的记忆，并列出可能需要我确认的过期信息。
```

### 先查再写

```text
先调用 Ymcp 的 memory_search 搜索：“Trae MCP 配置 init-trae”。
如果没有相同或高度相似记忆，再调用 memory_store 保存当前结论：
“ymcp init-trae 会检查 ~/.yjj、自动初始化默认记忆库，并更新 Trae CN 用户级 mcp.json；随后可创建 .trae/rules 项目规则。”
```

### 读取完整记忆

```text
根据刚才 memory_search 返回的 drawer_id，调用 Ymcp 的 memory_get 读取完整记忆内容。
然后判断这条记忆是否仍适用于当前项目。
```

### 更新过期记忆

```text
调用 Ymcp 的 memory_update，更新 drawer_id=<填入ID> 的记忆内容：
“Ymcp 当前已新增 memory_store、memory_search、memory_status 等 MemPalace 记忆工具。”
```

### 删除错误或敏感记忆

```text
调用 Ymcp 的 memory_delete 删除 drawer_id=<填入ID> 的记忆。
删除原因：该记忆包含错误信息或不应长期保存的敏感内容。
```

### 检查记忆库状态

```text
调用 Ymcp 的 memory_status，查看当前 MemPalace 记忆库状态、总记忆数以及 wing/room 分布。
```

### 使用知识图谱能力

```text
调用 Ymcp 的 memory_kg_add，写入关系：
subject="Ymcp"
predicate="uses"
object="MemPalace"
source="当前项目约定"
```

```text
调用 Ymcp 的 memory_graph_query，查询实体：“Ymcp”。
请总结与 Ymcp 相关的关系和可能影响当前开发的事实。
```

## 11. 记忆写入安全提醒

记忆写入是持久化副作用。Trae 调用 `memory_store`、`memory_update`、`memory_delete`、`memory_kg_add`、`memory_diary_write` 等工具前，应确认内容适合长期保存。遇到密钥、隐私、未经确认的事实，应先询问用户，不要直接保存。


## 工作流状态机投影

Ymcp 会把 `skills/` 中的工作流语义转换成 MCP 友好的状态机投影。工具不会直接执行工作流，Trae 宿主负责循环、提问、执行命令、保存状态和展示结果。

宿主应优先读取结构化字段推进流程，而不是依赖中文说明文案：

- `workflow_state.host_action_type`：告诉宿主本轮主要动作是 `ask_user`、`show_options`、`call_tool`、`collect_evidence`、`revise_plan` 还是 `run_host_execution`
- `continuation.continuation_kind`：告诉宿主本轮是等待用户回答、交接工具、等待用户选下一流程、继续执行还是补证据
- 当 `continuation.selection_required=true` 时，宿主不应结束对话，必须展示 `handoff_options`

推荐调用方式：

```text
调用 Ymcp 的 deep_interview。根据 workflow_state.host_next_action，把 next_question 展示给我；我回答后，再把 prior_rounds 传回 deep_interview。
```

```text
调用 Ymcp 的 ralplan，current_phase="planner_draft"。根据返回的 workflow_state.host_next_action，下一步切换到 Architect 视角审查，再把 architect_feedback 传回 ralplan。
```

```text
调用 Ymcp 的 ralph，把 approved_plan、latest_evidence 和 verification_commands 传入。根据 stop_continue_judgement 判断继续、修复还是完成。
```


## 12. Workflow 最佳调用链

### 链路 A：需求不清晰 → 规划 → 执行验证

适合“我要做一个功能，但范围还不确定”的场景。

1. 调用 `deep_interview` 获取下一问和 readiness gates。
2. 用户回答后，把问答追加到 `prior_rounds`，再次调用 `deep_interview`。
3. 当 `crystallize_ready=true` 或 `workflow_state.handoff_target="ralplan"` 时，调用 `ralplan`。
4. `ralplan` 按 `planner_draft → architect_review → critic_review` 顺序推进。
5. `ralplan` 返回 `handoff_target="ralph"` 后，把 approved plan、验证命令和最新证据交给 `ralph`。
6. `ralph` 返回 `continue/fixing/complete`，Trae 根据结果继续执行、修复或生成完成报告。
7. 完成后调用 `memory_store` 保存稳定偏好、项目约定或踩坑结论。

### 链路 B：需求已清楚 → 直接计划 → Ralph 循环

适合任务已有明确目标和验收标准的场景。

1. 调用 `plan`，传入 `mode="direct"`、`task`、`constraints` 和 `acceptance_criteria`。
2. Trae 根据 `implementation_steps` 执行宿主侧工作。
3. 每轮执行后调用 `ralph`，传入 `latest_evidence` 和 `verification_commands`。
4. 若 `ralph` 返回 `needs_input`，补齐证据；若返回 `fixing`，先修复失败；若返回 `complete`，输出最终报告。

### 链路 C：高风险或架构选择 → Ralplan 共识

适合架构、发布、兼容性、安全或多方案取舍任务。

1. 调用 `ralplan`，`current_phase="planner_draft"`。
2. 根据返回的 `architect_review_prompt`，让 Trae 以 Architect 视角审查方案。
3. 再调用 `ralplan`，`current_phase="architect_review"`，传入 `architect_feedback`。
4. 根据返回的 `critic_review_prompt`，让 Trae 以 Critic 视角检查可执行性和测试性。
5. 再调用 `ralplan`，`current_phase="critic_review"`，传入 `critic_feedback`。
6. 如果返回 `REVISE`，按 `revise_instructions` 修改后回到 Architect；如果返回 `APPROVE`，交给 `ralph`。

### 链路 D：长期偏好和项目知识沉淀

适合任务完成后沉淀稳定经验。

1. 调用 `memory_search` 搜索是否已有相似记忆。
2. 没有重复时调用 `memory_store` 保存稳定事实。
3. 如果已有但过期，先 `memory_get` 读取，再 `memory_update` 更新。
4. 如果发现错误或敏感信息，调用 `memory_delete` 删除。

## 13. Workflow 专用 Trae Prompt 模板

### deep_interview 多轮澄清模板

```text
调用 Ymcp 的 deep_interview 工具。
输入：
brief="<我的需求>"
profile="standard"
known_context=["<Trae 当前已知项目事实>"]

请根据返回的 workflow_state.host_next_action 执行：
- 如果返回 next_question，请只向我提出这个问题。
- 我回答后，把问答追加到 prior_rounds，再次调用 deep_interview。
- 如果 crystallize_ready=true，请总结 spec_skeleton，并准备交给 ralplan。
```

### plan 直接规划模板

```text
调用 Ymcp 的 plan 工具。
输入：
mode="direct"
task="<明确任务>"
constraints=["<必须遵守的约束>"]
acceptance_criteria=["<可测试验收标准>"]

请根据 artifacts.implementation_steps 输出执行计划，并保留 workflow_state 中的下一步建议。
```

### plan 自动分流模板

```text
调用 Ymcp 的 plan 工具。
输入：
mode="auto"
task="<当前任务>"
known_context=["<已有事实>"]

如果 recommended_next_tool="deep_interview"，请不要直接计划，先按 deep_interview 的下一问继续澄清。
如果返回 direct_plan，请输出计划并列出验证步骤。
```

### ralplan Planner 阶段模板

```text
调用 Ymcp 的 ralplan 工具。
输入：
task="<要规划的任务>"
current_phase="planner_draft"
deliberate=false

请读取返回的 principles、decision_drivers、viable_options 和 ADR 草案。
然后根据 architect_review_prompt，以 Architect 视角审查，不要声称调用了外部 agent。
```

### ralplan Architect → Critic 阶段模板

```text
调用 Ymcp 的 ralplan 工具。
输入：
task="<任务>"
current_phase="architect_review"
planner_draft="<上一轮计划草案>"
architect_feedback=["<架构审查结论>"]

请根据 critic_review_prompt，以 Critic 视角检查清晰度、测试性、风险和验证步骤。
然后把 critic_feedback 传回 ralplan 的 critic_review 阶段。
```

### ralplan 批准交接模板

```text
调用 Ymcp 的 ralplan 工具。
输入：
task="<任务>"
current_phase="critic_review"
planner_draft="<计划草案>"
architect_feedback=["<架构审查结论>"]
critic_feedback=[]

如果返回 handoff_contract，请把 target_tool、invocation_summary、required_inputs 和 constraints_to_preserve 整理成 ralph 调用输入。
```

### ralph 执行验证模板

```text
调用 Ymcp 的 ralph 工具。
输入：
approved_plan="<已批准计划摘要>"
latest_evidence=["<刚运行的测试/构建/lint/人工验证证据>"]
verification_commands=["python -m pytest", "python -m build"]
known_failures=[]

请根据 stop_continue_judgement 判断：
- continue：继续执行 recommended_next_action
- fixing：先修复 outstanding_risks 或 known_failures
- needs_more_evidence：补充 latest_evidence
- complete：输出 final_report_skeleton 对应的完成报告
```

### ralph 修复失败模板

```text
调用 Ymcp 的 ralph 工具。
输入：
approved_plan="<已批准计划摘要>"
latest_evidence=["<失败输出摘要>"]
verification_commands=["<应重新运行的验证命令>"]
known_failures=["<失败项1>", "<失败项2>"]
current_phase="verifying"

请只返回下一步修复建议和重新验证清单，不要宣布完成。
```

### 完成后记忆沉淀模板

```text
任务完成后，先调用 Ymcp 的 memory_search，搜索："<项目名> <本次稳定结论关键词>"。
如果没有重复记忆，再调用 memory_store 保存：
"<稳定事实/用户偏好/项目约定/踩坑结论>"
不要保存 token、密码、私钥、隐私或未经确认的推测。
```


## 14. 工作流开始前读取记忆

在调用 `deep_interview`、`plan`、`ralplan` 前，Trae 应优先根据当前需求调用 `memory_search` 读取相关长期记忆。这样可以复用历史偏好、项目约定、架构决策和踩坑结论，减少重复询问。

工具返回的 `workflow_state.memory_preflight` 会提示是否需要读取记忆：

- `required=true`：建议先调用 `memory_search`
- `query`：推荐搜索词
- `already_satisfied=true`：说明本次调用已经通过 `known_context` 或约束传入了相关上下文

推荐流程：

```text
在调用 deep_interview/plan/ralplan 前，先调用 Ymcp 的 memory_search。
query 使用当前需求标题、项目名和关键动作。
把搜索到的相关结果摘要放入 `known_context`，或优先传入结构化 `memory_context`，再调用目标工作流工具。
```

示例：

```text
先调用 memory_search，query="Ymcp Trae workflow 状态机"。
如果找到相关记忆，请把摘要作为 known_context 传给 deep_interview，然后再开始提问。
```

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

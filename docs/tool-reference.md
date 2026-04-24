# MCP 能力参考

Ymcp 的第一原则是 FastMCP-first：所有能力按 **Tools / Resources / Prompts** 三原语组织。Tools 执行动作或产生结构化结果；Resources 暴露可读取上下文；Prompts 暴露可复用调用模板。用户输入/选择优先使用 MCP 官方 Elicitation。

# Tools

## plan
返回 MCP 标准结构化计划结果；需要用户选择或补充输入时，优先通过官方 Elicitation 获取。

## ralplan
返回 MCP 标准结构化共识规划结果；批准后的下一步选择优先通过官方 Elicitation 获取。

## deep_interview
用于逐步澄清需求边界与意图。提问与下一步选择优先通过官方 Elicitation 获取，而不是自定义宿主协议。

## ralph
返回执行/验证状态、证据缺口和完成摘要。缺证据或完成后的下一步选择优先通过官方 Elicitation 获取。

# 记忆工具

默认记忆空间解析：优先使用显式 `wing`，否则使用宿主提供的 `project_id`，再退化到 `project_root` 目录名 slug，最后才回退 `wing="personal"`；默认 `room="ymcp"`。

Ymcp 的记忆工具统一通过 MemPalace MCP 服务执行。

## Memory Protocol

宿主和大模型应把 MemPalace 当作“先核验再作答”的长期记忆层，而不是普通文本仓库：

- 回答人物、项目、历史事件、过往决策或过去事实前，先调用 `mempalace_search`、`mempalace_get_drawer` 或图谱工具核验。
- 对事实不确定时，先说明需要查询记忆，再调用相关工具，禁止凭印象猜测。
- 任务或会话结束后，将稳定偏好、项目约定、重要决策和踩坑结论写入 `mempalace_add_drawer` 或 `mempalace_diary_write`。
- 已保存事实变化时，用 `mempalace_update_drawer`、`mempalace_delete_drawer`、`mempalace_kg_invalidate`、`mempalace_kg_add` 维护一致性。

## mempalace_add_drawer
写入一条 MemPalace 长期记忆。宿主可传 `project_id` / `project_root`，Ymcp 会在 `wing` 缺失时自动解析项目级 wing。

## mempalace_search
从 MemPalace 中搜索长期记忆。宿主可传 `project_id` / `project_root`，Ymcp 会在 `wing` 缺失时默认按当前项目 wing 过滤。

## mempalace_get_drawer / mempalace_update_drawer / mempalace_delete_drawer
通过 `drawer_id` 读取、更新或删除记忆。

## mempalace_status / mempalace_list_wings / mempalace_list_rooms / mempalace_get_taxonomy
查看记忆库状态、wing/room 分布和 taxonomy。

## mempalace_check_duplicate / mempalace_reconnect
检查重复内容，或刷新 Ymcp 到 MemPalace MCP 服务的连接状态。

## mempalace_graph_stats / mempalace_kg_query / mempalace_traverse
查看或遍历 MemPalace 图谱能力。

## mempalace_kg_add / mempalace_kg_timeline / mempalace_kg_invalidate
写入、查询时间线或失效化知识图谱关系。

## mempalace_create_tunnel / mempalace_list_tunnels / mempalace_find_tunnels / mempalace_follow_tunnels / mempalace_delete_tunnel
管理 MemPalace tunnel 关系。

## mempalace_diary_write / mempalace_diary_read
写入或读取 MemPalace diary 条目。

# Resources

Resources 用于把文档型上下文以 MCP 可发现、可读取的方式暴露给宿主；不得只写在 Markdown 文档中。

- `resource://ymcp/principles`：FastMCP 第一原则、三原语边界、Elicitation 规则。
- `resource://ymcp/tool-reference`：workflow tools 与 memory tools 的标准用途。
- `resource://ymcp/memory-protocol`：记忆核验、写入、更新、失效规则。
- `resource://ymcp/project-rule-template`：Trae / LLM 宿主项目规则模板。
- `resource://ymcp/host-integration`：宿主集成说明和 MCP-first 使用约束。

# Prompts

Prompts 只生成可复用调用模板，不直接执行工具，也不伪造工具结果。

- `deep_interview_clarify`：启动需求澄清。
- `plan_direct`：明确任务的直接计划。
- `ralplan_consensus`：高风险/架构型共识规划。
- `ralplan_planner_pass`：以 Planner 视角起草 ralplan draft。
- `ralplan_architect_pass`：以 Architect 视角审查 ralplan draft。
- `ralplan_critic_pass`：以 Critic 视角评估 ralplan draft。
- `ralph_verify`：执行后证据判断和继续/修复/完成决策。
- `memory_store_after_completion`：任务结束后沉淀长期记忆。

## Trae 调用建议

- 保存长期偏好：优先使用 `mempalace_add_drawer`。
- 搜索历史上下文：优先使用 `mempalace_search`。
- 维护已有记忆：搜索得到 `drawer_id` 后，再使用 `mempalace_get_drawer`、`mempalace_update_drawer` 或 `mempalace_delete_drawer`。
- 写入前去重：重要结论保存前，可先调用 `mempalace_check_duplicate` 或 `mempalace_search`。
- 查看记忆库状态：使用 `mempalace_status`、`mempalace_list_wings`、`mempalace_list_rooms`。

# 工作流状态机投影

`plan`、`ralplan`、`deep_interview`、`ralph` 均返回 `workflow_state`。这表示工具不会直接执行 workflow，而是把当前阶段、readiness、证据缺口和记忆预检结果投影给客户端。

## MCP 第一规范

- 能力优先按 Tools / Resources / Prompts 三原语组织。
- 用户输入、选择和表单交互优先使用 MCP 官方 Elicitation。
- 工具输出优先使用 MCP tools 的标准结构化结果。
- 不再把自定义 `interaction`、`continuation`、`handoff_options` 作为主协议。

`workflow_state` 常见字段：

- `workflow_name`
- `current_phase`
- `readiness`
- `evidence_gaps`
- `blocked_reason`
- `skill_source`
- `memory_preflight`

## 推荐组合链路

- `deep_interview → ralplan → ralph`：从模糊需求到批准计划再到执行验证。
- `plan(mode="direct") → ralph`：明确任务的快速计划与验证循环。
- `ralplan(current_phase="planner_draft") → ralplan(current_phase="architect_review") → ralplan(current_phase="critic_review")`：顺序模拟 Planner / Architect / Critic 视角。
- `mempalace_search → mempalace_add_drawer`：任务完成后先查重再沉淀长期记忆。

## memory_preflight

`deep_interview`、`plan`、`ralplan` 的 `workflow_state` 中会包含 `memory_preflight`。宿主应根据它判断是否在工作流开始前先调用 `mempalace_search`。

- `required=true`：建议先读取记忆
- `query`：推荐传给 `mempalace_search` 的查询词
- `already_satisfied=true`：说明本次调用已经提供了相关上下文

新宿主推荐直接传结构化 `memory_context`：

- `searched`：是否已执行记忆检索
- `hits`：命中的记忆摘要列表
- `failed`：检索是否失败
- `query`：检索查询词

旧的 `known_context` 文本摘要仍兼容，但推荐优先使用结构化 `memory_context`。

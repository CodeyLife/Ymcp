# 工具参考

## plan
返回结构化计划草案、假设、验收标准和宿主下一步动作建议。

## ralplan
返回共识规划包，包括原则、决策驱动、可选方案、ADR 内容和测试策略。

## deep_interview
只返回下一问和评分建议。MCP 宿主负责询问用户，并维护 transcript/state。

## ralph
只返回宿主下一步动作建议。不执行命令、不 spawn agent、不修改文件、不持久化循环，也不自行验证完成。


# 记忆工具

默认记忆空间：`wing="personal"`、`room="ymcp"`。

## Memory Protocol

宿主和大模型应把 MemPalace 当作“先核验再作答”的长期记忆层，而不是普通文本仓库：

- 唤醒、恢复上下文或进入工作流时，先调用 `memory_status` 读取记忆库概览。
- 回答人物、项目、历史事件、过往决策或过去事实前，先调用 `memory_search`、`memory_get` 或图谱工具核验。
- 对事实不确定时，先说明需要查询记忆，再调用相关工具，禁止凭印象猜测。
- 任务或会话结束后，将稳定偏好、项目约定、重要决策和踩坑结论写入 `memory_store` 或 `memory_diary_write`。
- 已保存事实变化时，用 `memory_update`、`memory_delete`、`memory_kg_invalidate`、`memory_kg_add` 维护一致性。

## memory_store
写入一条 MemPalace 长期记忆。

## memory_search
从 MemPalace 中搜索长期记忆。

## memory_get / memory_update / memory_delete
通过 `drawer_id` 读取、更新或删除记忆。

## memory_status / memory_list_wings / memory_list_rooms / memory_taxonomy
查看记忆库状态、wing/room 分布和 taxonomy。

## memory_check_duplicate / memory_reconnect
检查重复内容，或刷新 MemPalace 连接和缓存。

## memory_graph_stats / memory_graph_query / memory_graph_traverse
查看或遍历 MemPalace 图谱能力。

## memory_kg_add / memory_kg_timeline / memory_kg_invalidate
写入、查询时间线或失效化知识图谱关系。

## memory_create_tunnel / memory_list_tunnels / memory_find_tunnels / memory_follow_tunnels / memory_delete_tunnel
管理 MemPalace tunnel 关系。

## memory_diary_write / memory_diary_read
写入或读取 MemPalace diary 条目。


## Trae 调用建议

- 保存长期偏好：优先使用 `memory_store`，内容写成完整自然语言，便于未来搜索。
- 搜索历史上下文：优先使用 `memory_search`，搜索词应包含项目名、主题和动作，例如“Ymcp Trae 初始化”。
- 维护已有记忆：搜索得到 `drawer_id` 后，再使用 `memory_get`、`memory_update` 或 `memory_delete`。
- 写入前去重：重要结论保存前，可先调用 `memory_check_duplicate` 或 `memory_search`。
- 查看记忆库状态：使用 `memory_status`、`memory_list_wings`、`memory_list_rooms`。


# 工作流状态机投影

`plan`、`ralplan`、`deep_interview`、`ralph` 均返回 `workflow_state`。这表示 MCP 工具不会直接执行 workflow，而是把 skill 的阶段、门槛、下一步和交接信息投影给 Trae。Trae 负责循环调用、提问、执行命令、保存状态和展示结果。

`workflow_state` 常见字段：

- `workflow_name`：当前工作流名称
- `current_phase`：当前阶段
- `readiness`：是否需要输入、修订、验证或可交接
- `host_next_action`：Trae 下一步应该做什么
- `host_action_type`：宿主动作类型，建议优先按结构化类型推进，而不是解析自然语言文案
- `required_host_inputs`：宿主还需要补充的输入
- `handoff_target`：建议交接的下一个工具
- `handoff_contract`：交接约束或摘要
- `evidence_gaps`：缺失证据
- `skill_source`：语义来源 skill 文档

`continuation` 常见字段：

- `continuation_required=true`：当前轮不能直接结束，宿主还必须继续推进
- `selection_required=true`：必须向用户展示选项并等待选择
- `continuation_kind`：结构化下一步类型，例如 `user_answer`、`handoff_to_tool`、`select_handoff_option`、`select_completion_option`
- `recommended_user_message`：当需要用户回答或选择时，宿主可直接复用的提示文案


## 推荐组合链路

- `deep_interview → ralplan → ralph`：从模糊需求到批准计划再到执行验证。
- `plan(mode="direct") → ralph`：明确任务的快速计划与验证循环。
- `ralplan(current_phase="planner_draft") → ralplan(current_phase="architect_review") → ralplan(current_phase="critic_review")`：在 Trae 中顺序模拟 Planner / Architect / Critic 视角。
- `memory_search → memory_store`：任务完成后先查重再沉淀长期记忆。


## memory_preflight

`deep_interview`、`plan`、`ralplan` 的 `workflow_state` 中会包含 `memory_preflight`。宿主应根据它判断是否在工作流开始前先调用 `memory_search`。

- `required=true`：建议先读取记忆
- `query`：推荐传给 `memory_search` 的查询词
- `already_satisfied=true`：本次调用已经提供了相关上下文

新宿主推荐直接传结构化 `memory_context`：

- `searched`：是否已执行记忆检索
- `hits`：命中的记忆摘要列表
- `failed`：检索是否失败
- `query`：检索查询词

旧的 `known_context` 文本摘要仍兼容，但仅作为 legacy path。

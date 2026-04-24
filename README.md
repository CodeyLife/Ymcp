# Ymcp
Trae MCP工具包  提供工作流以及mempalace的长记忆存储

# 安装与更新

```powershell
pip install ymcp
pip install -U ymcp
```

本地开发安装：

```powershell
python -m pip install -e .[dev]
```

安装后建议检查：

```powershell
ymcp doctor
ymcp --version
ymcp inspect-tools --json
ymcp inspect-resources --json
ymcp inspect-prompts --json
ymcp inspect-capabilities --json
```

一键初始化 Trae 与默认记忆库：

```powershell
ymcp init-trae
```

`init-trae` 会检查 `~/.yjj`。如果该目录不存在，会自动初始化 MemPalace，并把 `~/.yjj` 配置为 Ymcp 的默认记忆库目录。

## FastMCP 第一原则

Ymcp 的第一原则是：所有能力优先按 FastMCP / MCP 官方三原语组织，而不是只提供 tools-only 接口：

- **Tools**：执行动作、查询外部系统、产生结构化结果。
- **Resources**：暴露可读取上下文、项目原则、规则模板、工具参考、记忆协议。
- **Prompts**：暴露可复用调用模板和标准工作流提示；Prompt 不直接执行工具，也不伪造工具结果。
- **Elicitation**：当 Tool 执行中需要用户输入/选择时，优先使用 MCP 官方 Elicitation；不支持时返回标准 `needs_input` / `blocked` 结构化降级结果。

标准 Resources：

- `resource://ymcp/principles`
- `resource://ymcp/tool-reference`
- `resource://ymcp/memory-protocol`
- `resource://ymcp/project-rule-template`
- `resource://ymcp/host-integration`

标准 Prompts：

- `deep_interview_clarify`
- `plan_direct`
- `ralplan_consensus`
- `ralplan_planner_pass`
- `ralplan_architect_pass`
- `ralplan_critic_pass`
- `ralph_verify`
- `memory_store_after_completion`

禁止用自定义宿主协议替代 MCP 原语；禁止把文档型上下文只放在 Markdown 中而不暴露为 Resource；禁止把可复用提示只写在文档中而不暴露为 Prompt。


## 记忆工具

Ymcp 依赖 `mempalace` 提供长期记忆能力，默认使用 `~/.yjj` 作为 MemPalace 记忆库目录，并写入全局个人记忆空间：`wing="personal"`、`room="ymcp"`。

当前实现已统一为单一路径：

- Ymcp **只**通过 `python -m mempalace.mcp_server` 调用 MemPalace
- Ymcp **不再**直接导入或调用 MemPalace 的进程内 Python 实现
- 所有记忆读写、检索、图谱与 diary 能力都统一经过这条 MCP 调用链

Memory Protocol：回答人物、项目、历史事件或过往决策前先查 `mempalace_search` / `mempalace_get_drawer`，不要凭印象猜；任务结束后把稳定偏好、项目约定、重要决策和踩坑结论写入 `mempalace_add_drawer` 或 `mempalace_diary_write`；事实变化时用更新、删除或 KG 失效工具维护旧记忆。

常用工具：

- `mempalace_add_drawer`：保存一条长期记忆
- `mempalace_search`：搜索长期记忆
- `mempalace_get_drawer` / `mempalace_update_drawer` / `mempalace_delete_drawer`：读取、更新、删除指定记忆
- `mempalace_status` / `mempalace_list_wings` / `mempalace_list_rooms` / `mempalace_get_taxonomy`：查看记忆空间状态
- `mempalace_kg_*`、`mempalace_graph_*`、`mempalace_*tunnel*`、`mempalace_diary_*`：通过 MemPalace MCP 服务暴露图谱、关系和日记能力

记忆写入是持久化副作用。请不要保存密钥、隐私或未经确认的敏感信息。


## Trae 中常用记忆 prompt

```text
调用 Ymcp 的 mempalace_search，搜索：“当前项目的发布流程”。请只总结与当前任务相关的记忆。
```

```text
调用 Ymcp 的 mempalace_add_drawer，保存这条长期项目约定：“Ymcp 的文档和用户回复都使用中文，代码接口名保持英文。”
```

更多示例见 `docs/trae-integration.md`。


## Trae Workflow 最佳调用链

推荐链路：`deep_interview → ralplan → ralph → mempalace_add_drawer`。

- 需求不清晰：先调用 `deep_interview`，按 `next_question` 多轮澄清。
- 需要共识规划：调用 `ralplan`，按 `planner_draft → architect_review → critic_review` 推进。
- 执行验证：调用 `ralph`，根据 `stop_continue_judgement` 继续、修复或完成。
- 完成沉淀：调用 `mempalace_search` 查重，再用 `mempalace_add_drawer` 保存稳定经验。

完整 prompt 模板见 `docs/trae-integration.md`。

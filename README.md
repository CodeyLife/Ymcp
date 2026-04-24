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
- **Elicitation**：当 Tool 执行中需要用户输入/选择时，只通过 MCP 官方 Elicitation 收集；不支持或渲染异常的不应继续 workflow 交互。

禁止用自定义协议替代 MCP 原语；禁止把文档型上下文只放在 Markdown 中而不暴露为 Resource；禁止把可复用提示只写在文档中而不暴露为 Prompt。


## 记忆工具

Ymcp 依赖 `mempalace` 提供长期记忆能力，默认使用 `~/.yjj` 作为 MemPalace 记忆库目录。记忆 wing 现在按项目上下文解析：优先使用显式 `wing`，否则使用提供的 `project_id`，再退化到 `project_root` 目录名 slug，最后才回退到 `wing="personal"`；默认 `room="ymcp"`。

当前实现已统一为单一路径：

- Ymcp **只**通过 `python -m mempalace.mcp_server` 调用 MemPalace
- Ymcp **不再**直接导入或调用 MemPalace 的进程内 Python 实现
- 所有记忆读写、检索、图谱与 diary 能力都统一经过这条 MCP 调用链

Memory Protocol：回答人物、项目、历史事件或过往决策前先查 `mempalace_search` / `mempalace_get_drawer`，不要凭印象猜；任务结束后把稳定偏好、项目约定、重要决策和踩坑结论写入 `mempalace_add_drawer` 或 `mempalace_diary_write`；事实变化时用更新、删除或 KG 失效工具维护旧记忆。

推荐在记忆工具调用里补充：

- `project_id`：稳定的项目标识，优先用于生成 wing
- `project_root`：工程根目录，作为 `project_id` 缺失时的回退来源

这样不同工程会自动写入不同的 wing，而不是全部落到 `personal`。

常用工具：

- `mempalace_add_drawer`：保存一条长期记忆
- `mempalace_search`：搜索长期记忆
- `mempalace_get_drawer` / `mempalace_update_drawer` / `mempalace_delete_drawer`：读取、更新、删除指定记忆
- `mempalace_status` / `mempalace_list_wings` / `mempalace_list_rooms` / `mempalace_get_taxonomy`：查看记忆空间状态
- `mempalace_kg_*`、`mempalace_graph_*`、`mempalace_*tunnel*`、`mempalace_diary_*`：通过 MemPalace MCP 服务暴露图谱、关系和日记能力

记忆写入是持久化副作用。


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

这条链路中的**循环、执行、验证与状态保存都由宿主控制**；Ymcp 只提供 MCP Tools / Resources / Prompts、结构化 workflow 状态，以及在需要用户输入时发起 Elicitation。Ymcp 不是 agent runtime，不会自动执行命令、修改文件或持续运行 loop。

- 需求不清晰：先调用 `deep_interview`，按服务器发起的 Elicitation 多轮澄清。
- 需要共识规划：调用 `ralplan`，由宿主按 `planner_draft → architect_review → critic_review` 顺序推进，并把真实评审结果回传给工具。
- 执行验证：调用 `ralph`，根据 `stop_continue_judgement` 判断继续、修复或完成；`ralph` 是证据驱动的闭环判断工具，不是执行器。
- 完成沉淀：调用 `mempalace_search` 查重，再用 `mempalace_add_drawer` 保存稳定经验。

权威接入契约见 `docs/workflow-contract.md`，实现细则见 `docs/host-implementation-guide.md`，完整 prompt 模板见 `docs/trae-integration.md`。

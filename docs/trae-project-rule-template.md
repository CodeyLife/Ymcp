# Ymcp 项目规则模板

## MCP 第一规范

- Ymcp 能力按 FastMCP 三原语组织：Tools / Resources / Prompts。
- Tools 用于执行动作、查询外部系统、产生结构化结果；Resources 用于读取项目原则、规则模板、工具参考和记忆协议；Prompts 用于生成可复用调用模板。
- 一切流程优先遵守 MCP 官方标准能力；不要为 workflow 自定义宿主私有交互协议。
- 用户输入、选择和表单交互优先使用 MCP Elicitation；不支持 Elicitation 时，仅返回标准结构化工具结果说明缺失输入。
- 工具输出使用 MCP tools 的标准结构化结果；不要依赖自定义 `interaction`、`continuation` 或重复菜单协议作为主协议。
- 文档型上下文必须同时暴露为 Resource；可复用提示必须同时暴露为 Prompt。

## 记忆规则

- 需要历史事实、项目约定、偏好、决策或上下文时，先用 `mempalace_search` / `mempalace_get_drawer` 核验；不要凭印象猜。
- 任务结束后，如有稳定偏好、项目约定、重要决策或踩坑结论，先查重，再用 `mempalace_add_drawer` / `mempalace_diary_write` 保存；旧事实变化时用 `mempalace_update_drawer`、`mempalace_delete_drawer`、`mempalace_kg_invalidate`、`mempalace_kg_add` 维护。

## 推荐 workflow

- 需求不清晰：`deep_interview`
- 明确任务直接计划：`plan`
- 高风险或架构型共识规划：`ralplan`
- 执行后证据判断：`ralph`

## 禁止

- 禁止把 Ymcp 描述为 agent runtime，或声称它会自动执行、自动修改、自动验证。
- 禁止伪造用户回答、执行结果、测试结果或文件修改。
- 禁止在关键前提、证据或用户选择缺失时宣布完成。

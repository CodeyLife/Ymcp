# Ymcp

Trae / 通用 LLM 宿主可用的 MCP 工具包，提供 `ydeep`、`yplan`、`ydo` 等 workflow tools，以及基于 MemPalace 的长期记忆能力。

## 核心模型

- **tool 负责 gate**：阶段完成态、下一步约束、Elicitation 选项
- **skill 负责思考**：具体推理过程由 LLM 自主完成
- **LLM 自主循环**：不再由 MCP 逐步编排内部思考

## 当前 workflow tools

- `ydeep`
  - 对应 prompt：`deep-interview`
  - 调用时应明确要求模型使用 `deep-interview` prompt 做需求调研
  - 输入核心：`brief`
  - 返回 `completion_tool=ydeep_complete`
  - 同时直接返回 `skill_content`
- `yplan`
  - 对应 prompt：`planner`
  - 返回 `next_tool=yplan_architect`
  - 同时直接返回 `skill_content`
- `ydo`
  - 对应 prompt：`ralph`
  - 返回 `completion_tool=ydo_complete`
  - 同时直接返回 `skill_content`

## 安装

```powershell
pip install ymcp
```

## 更新

```powershell
pip install -U ymcp
```

## 一键初始化 Trae 与默认记忆库

```powershell
ymcp init-trae
```

## 记忆

回答历史事实前先查 `mempalace_search` / `mempalace_get_drawer`；任务完成后把稳定偏好、项目约定、重要决策和踩坑结论写入 `mempalace_add_drawer` 或 `mempalace_diary_write`。

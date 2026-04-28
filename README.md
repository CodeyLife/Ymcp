# Ymcp

Trae / 通用 LLM 宿主可用的 MCP 工具包，提供 `ydeep`、`yplan`、`ydo` 等 workflow tools，以及基于 MemPalace 的长期记忆能力。

## 核心模型

- **tool 负责轻 gate**：阶段入口、统一 handoff、Elicitation 选项、必要时产出最终交接 artifact
- **skill 负责思考**：具体推理过程由 LLM 自主完成
- **LLM 自主循环**：Ymcp 不维护重型服务端状态机，只提供关键流转约束
- **中间阶段不回灌复杂状态**：同一调用链内由 LLM 自己承接上下文
- **handoff.options 更接近菜单项**：重点是 `value`、`title`、`description`、`recommended`

## 当前 workflow tools

- `ydeep`
  - 对应 prompt：`deep-interview`
  - 输入核心：`brief`
  - 输出核心：`skill_content`、统一 `handoff`
- `yplan`
  - 对应 prompts：`planner` → `architect` → `critic`
  - 输入核心：`task`
  - 输出核心：阶段 `skill_content`、统一 `handoff`
  - 阶段链路：`yplan -> yplan_architect -> yplan_critic -> yplan_menu`
- `ydo`
  - 对应 prompt：`ralph`
  - 输入核心：无业务输入（依赖当前调用链上下文）
  - 输出核心：`skill_content`、统一 `handoff`

## Handoff contract

- `handoff.options` 是下一步动作的唯一权威源
- tool 只声明“有哪些下一步选项”，不声明自动参数映射协议
- 推荐宿主按固定约定串联阶段，而不是让 LLM 或 tool 维护复杂路由协议
- `ydeep_menu` 默认只进入 `yplan`，不再直接跳到 `ydo`
- `yplan` 只接受 `task`；如果来源是 `clarified_artifact`，应由宿主先转换为普通 `task`
- `yplan_critic` 只声明两个合法下一步：`yplan` 或 `yplan_menu`
- `yplan_critic` 不强制固定 `APPROVE/REVISE` 协议；由 LLM 自行判断是批准收口，还是强制回到 `yplan` 重开规划
- `yplan_menu` / `ydo_menu` 现在是更彻底的无输入收口阶段：调用它本身就表示 LLM 认为当前阶段已结束
- 只有 `ydeep_menu` 仍产出 `clarified_artifact`；planning / execution 的 流程菜单阶段不再要求输入摘要或构造中间 artifact

## 设计边界

- MCP tool 提供结构化阶段边界与下一步选项
- LLM 先完整思考与输出，再由宿主点击流程菜单 / next-step 进入下一个 workflow
- 流程菜单工具（`ydeep_menu` / `yplan_menu` / `ydo_menu`）在关键节点提供 handoff 选项，并**必须**通过 **Elicitation** 或宿主等价交互控件向用户展示菜单
- 若当前宿主不支持 MCP Elicitation，或 Elicitation 调用失败，流程菜单工具应返回 `blocked`，并明确进入“宿主必须用 `handoff.options` 渲染真实可交互菜单并等待用户选择”的兜底模式；不得静默降级为普通文本列表，不得让 assistant 代渲染文字菜单，也不得让 LLM 代选或自动继续
- 宿主菜单不要求逐字多行还原 description，但必须保留每个选项的 `value` / `title` / `recommended`；`description` 可作为详情、tooltip 或辅助文本呈现
- `host_controls` 仅表达当前返回实际依赖的宿主能力
- `status` 表示当前 tool 调用结果；`meta.required_host_action` 只表达宿主当前是“继续思考”还是“展示并收口”
- `handoff.options` 是下一步动作的**唯一权威源**；`allowed_next_actions` 仅为派生兼容视图
- `handoff.options` 应被视为服务端给出的菜单，而不是让 LLM 自己构造的路由对象
- `recommended_next_action` 只是推荐，不代表授权自动执行；必须先完成用户选择
- 流程菜单 tool 的 `workflow_state` 会显式表达 handoff 状态流转，例如 `ready_for_handoff`、`elicitation_requested`、`awaiting_user_selection`、`selection_confirmed`

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

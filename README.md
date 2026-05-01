# Ymcp

Trae / 通用 LLM 宿主可用的 MCP 工具包，提供 `ydeep`、`yplan`、`ydo` 等 workflow tools，以及基于 MemPalace 的长期记忆能力。

## 核心模型

- **tool 负责轻 gate**：阶段入口、统一 handoff、Elicitation 选项、必要时产出最终交接 artifact
- **skill 负责思考**：具体推理过程由 LLM 自主完成
- **LLM 自主循环**：Ymcp 不维护重型服务端状态机，只提供关键流转约束
- **规划阶段显式回灌总结**：`yplan` 通过 phase 参数记录 planner / architect / critic 的可审计总结，不暴露内部思考
- **handoff.options 更接近菜单项**：重点是 `value`、`title`、`description`、`recommended`

## 当前 workflow tools

- `ydeep`
  - 对应 prompt：`deep-interview`
  - 输入核心：`brief`
  - 输出核心：`skill_content`、统一 `handoff`
  - 完成澄清并输出总结后调用统一 `menu`
- `yplan`
  - 对应 prompt：`plan` / `planner`
  - 输入核心：`task`、可选 `phase`、`planner_summary`、`architect_summary`、`critic_verdict`、`critic_summary`
  - 输出核心：`skill_content`、统一 `handoff`
  - planner / architect / critic 是 `yplan` 内部阶段，不再作为公开 MCP tools 暴露
  - `phase=start` 返回完整 `plan` skill；后续阶段必须显式回传对应总结，Critic 只接受 `APPROVE` / `ITERATE` / `REJECT`
  - 完成规划、架构审视、critic 验收并输出总结后调用统一 `menu`
- `ydo`
  - 对应 prompt：`ralph`
  - 输入核心：无业务输入（依赖当前调用链上下文）
  - 输出核心：`skill_content`、统一 `handoff`
  - 完成执行与验证并输出总结后调用统一 `menu`
- `menu`
  - 唯一公开流程菜单 tool
  - 输入核心：`source_workflow`、`summary`、`options`、可选 `selected_option`
  - 优先使用 MCP Elicitation；失败时提供本地 WebUI fallback 交互选择

## Handoff contract

- `handoff.options` 是下一步动作的唯一权威源
- tool 只声明“有哪些下一步选项”，不声明自动参数映射协议
- 推荐宿主按固定约定串联阶段，而不是让 LLM 或 tool 维护复杂路由协议
- `menu` 的 `options` 由当前 workflow skill 在完成任务并输出总结后作为参数传入
- `recommended_next_action` 只是推荐，不代表授权自动执行；必须先完成用户选择

## 设计边界

- MCP tool 提供结构化阶段边界与下一步选项
- LLM 先完整思考与输出，再调用统一 `menu` 进入 next-step 选择
- `menu` 必须优先通过 **Elicitation** 向用户展示菜单
- 若当前宿主不支持 MCP Elicitation，或 Elicitation 调用失败、取消、拒绝或返回非法选项，`menu` 返回 `blocked` 并提供 `meta.ui_request.webui_url`，由本地 WebUI 渲染真实可交互选项
- WebUI fallback 默认绑定 `127.0.0.1`，使用随机 token；只允许查看当前 menu session 与提交合法 option value，不提供命令执行能力
- 宿主菜单不要求逐字多行还原 description，但必须保留每个选项的 `value` / `title` / `recommended`；`description` 可作为详情、tooltip 或辅助文本呈现
- `host_controls` 仅表达当前返回实际依赖的宿主能力
- `status` 表示当前 tool 调用结果；`meta.required_host_action` 只表达宿主当前是“继续思考”还是“展示并收口”
- `handoff.options` 是下一步动作的**唯一权威源**；`allowed_next_actions` 仅为派生兼容视图
- `handoff.options` 应被视为服务端给出的菜单，而不是让 LLM 自己构造的路由对象
- `menu` 的 `workflow_state` 会显式表达 handoff 状态流转，例如 `ready_for_handoff`、`elicitation_requested`、`awaiting_user_selection`、`selection_confirmed`

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

## 本地图像 / 视频帧工具

安装可选 Pillow 支持后可使用本地帧处理命令；视频抽帧还需要系统可执行的 `ffmpeg` / `ffprobe`。

```powershell
pip install "ymcp[imagegen]"
ymcp v2f 12 input.mp4 --seconds 1-2 --size 256 --out output/frames
ymcp v2f 8 input.mp4 --seconds 2 --size full
ymcp v2f 12 input.mp4 --columns 6
```

`--seconds 2` 表示使用 0-2 秒，`--seconds 1-2` 表示使用 1-2 秒；`--size` 默认 `256`，`full` 保留原视频分辨率，也支持 `320x180`。该命令不会保留中间采样 PNG，默认在当前目录下的 `video_frames` 输出目录生成 `framesheet.png` 和 `animation.webp`。framesheet 默认尽量接近方形，例如 24 帧为 4x6、20 帧为 4x5，可用 `--columns` 覆盖列数。默认会用第一帧中出现最多的颜色作为背景色，并在所有帧中复用该颜色扣除背景；如需保留背景可传 `--keep-bg`。`v2f` 默认还会从画面中心按半径添加透明淡出，减少边缘裁剪截断感；`--fade 80` 表示中心 80% 半径保持不透明后线性淡出，`--fade 80-2` 可调整衰减速度。

### 本地 v2f 网页编辑器

`ymcp v2f-ui` 会启动一个本机单用户网页编辑器，默认只监听 `127.0.0.1`，用于反复调参预览，而不是多用户服务、批量任务或云端部署。

```powershell
ymcp v2f-ui
ymcp v2f-ui --port 8765 --no-open
```

编辑器把流程拆成两层：视频抽帧只在视频来源、采样时间段、帧数或解码尺寸变化时执行；背景扣除、透明淡出、裁剪/缩放、Timing Map 节奏曲线、预览和导出会复用当前 session 中缓存的帧。除了视频输入，编辑器也支持从已有 framesheet + grid 创建 session，再进入同一套视觉处理、节奏编辑和 `framesheet.png` / `animation.webp` 导出流程。

Timing Map 使用单调关键点曲线把输出动画进度映射到源帧进度，可用于“蓄力趋静止 → 爆发加速 → 回落”的节奏。v1 导出采用确定性的 nearest-frame 选择，不做光流或中间帧合成。

## 记忆

回答历史事实前先查 `mempalace_search` / `mempalace_get_drawer`；任务完成后把稳定偏好、项目约定、重要决策和踩坑结论写入 `mempalace_add_drawer` 或 `mempalace_diary_write`。

---
name: deep-interview
description: 面向规划或执行前的苏格拉底式需求澄清；保留参考工作流的量化歧义门、压力追问和规格化交接思路
argument-hint: "[--quick|--standard|--deep] [--autoresearch] <想法、目标或模糊描述>"
---

# Deep Interview / 深度访谈

## 作用

`deep-interview` 用于在规划或执行前做**意图优先**的苏格拉底式需求澄清。它参考原 OMX 工作流的核心思想：

- 用一轮一个高杠杆问题逼近真实意图
- 用量化歧义分数判断是否足够清晰
- 把非目标、决策边界、验收标准作为强 gate
- 在进入执行前形成可交接的规格说明

在 Ymcp 中，这些是**LLM 执行方法与输出约束**，而不是服务端维护的重型状态机。`ydeep` 只返回本 skill guidance；模型完成澄清与总结后，必须调用统一 `menu` tool 交接。

## 在 Ymcp 中的工作方式

当前项目为了适配 Trae / 通用 MCP 宿主，保留了轻量 skill-flow 边界：

1. `ydeep(brief=...)` 返回 `deep-interview` 的 `skill_content`。
2. 模型按本文档完成澄清循环、输出可见总结。
3. 模型调用统一 `menu` tool：
   - `source_workflow="ydeep"`
   - `summary=<澄清总结>`
   - `options=[yplan, refine_further]`
4. `menu` 才是唯一流程菜单 gate；后续下一步以 `handoff.options` 为唯一权威来源。

适配方式：`.omx/context/`、`.omx/interviews/`、`.omx/specs/` 在 Ymcp 中是**建议产物与思考协议**。宿主/模型可在具备文件与状态能力时沉淀，但不能把未实际生成的文件声称为已存在。

## 适用场景

- 请求宽泛、模糊，缺少明确验收标准
- 用户明确表示“先别假设”“先问清楚”“访谈我”“deep interview”
- 任务容易因为边界不清而误实现
- 在进入 `yplan` / `ydo` 前需要形成需求说明
- 需要把“意图、边界、非目标、约束、验收标准”先收敛清楚

## 不适用场景

- 任务已经有具体文件/符号/验收标准
- 已经有完整计划或 PRD，应直接进入规划收口或执行
- 用户明确要求跳过访谈、立即执行
- 只是轻量 brainstorming，而不是执行前澄清

## 深度档位与歧义阈值

- **Quick (`--quick`)**：快速预检；目标歧义 `<= 0.30`；最多 5 轮
- **Standard (`--standard`, 默认)**：常规需求访谈；目标歧义 `<= 0.20`；最多 12 轮
- **Deep (`--deep`)**：高风险/高歧义；目标歧义 `<= 0.15`；最多 20 轮
- **Autoresearch (`--autoresearch`)**：同 Standard 严谨度，但面向 research mission / evaluator / keep-policy / slug 的下游交接

如果没有显式指定档位，默认按 **Standard**。

## 执行原则

### 1. 一轮只问一个高杠杆问题
不要一轮抛出多个并列问题。每轮只追当前最影响边界、验收或交接质量的那个问题。

### 2. 先问意图和边界，再问实现细节
优先澄清：为什么做、最终想得到什么、第一阶段包含什么、明确不做什么、哪些决定需要确认。

### 3. 优先追最弱维度，而不是平均覆盖
不要为了“每类都问一遍”而浅尝辄止。应优先追当前最弱、最模糊、最容易导致误实现的维度。

### 4. 必须做 pressure pass
在准备收敛前，至少回头挑战一次前面答案：要求例子/反例、暴露隐藏假设、迫使 tradeoff 或排除项、把症状追问到本质诉求。

### 5. Brownfield 先看事实，再问偏好
如果是已有仓库上的改动，先查代码事实和已有模式，再问“是否沿用现有模式”。不要把可从仓库查到的事实问题丢给用户。

### 6. 只有足够清晰时才 handoff
如果意图、边界、非目标、约束或成功标准仍有关键缺口，不要急着 handoff 到下游执行模式。

## Phase 0：上下文预检

在第一轮问题前，整理最小上下文：

- task statement / 用户原始诉求
- desired outcome / 希望结果
- known facts / 已知事实和证据
- constraints / 约束
- unknowns / 未知项
- decision-boundary unknowns / 决策边界未知项
- likely codebase touchpoints / 可能涉及的仓库位置
- prompt-safe summary status / 是否需要把超大上下文先压缩为安全摘要

如宿主允许文件写入，可沉淀为 `.omx/context/{slug}-{timestamp}.md`；否则在对话上下文中维护等价摘要。

## Phase 1：初始化澄清方向

判断：

- 当前是 quick / standard / deep 哪种档位
- 当前更像 greenfield 还是 brownfield
- 第一轮应攻击哪个最弱维度
- 是否存在超大初始上下文；若存在，第一轮只要求用户/宿主提供 prompt-safe 摘要，暂不评分、不 handoff

## Phase 2：苏格拉底式访谈循环

重复直到歧义分数低于阈值、pressure pass 完成、两个 readiness gate 明确，或达到轮数上限。

### 2a. 生成下一问

阶段优先级：

1. **Intent-first**：Intent、Outcome、Scope、Non-goals、Decision Boundaries
2. **Feasibility**：Constraints、Success Criteria
3. **Brownfield grounding**：Context Clarity（仅 brownfield）

每轮从最低分/最高风险维度发问，但不要为了覆盖面而跳过同一线程上的关键追问。

追问阶梯：

1. 要求具体例子、反例或证据信号
2. 追问使该说法成立的隐藏假设/依赖
3. 强迫边界或取舍：明确不做、延后或拒绝什么
4. 若回答仍停留在症状，追问本质/根因

### 2b. 提问方式

在 Ymcp 中，优先使用宿主提供的结构化输入能力；若当前宿主只支持普通对话，就用一个简短问题继续，但仍必须保持“一轮一个问题”。不要伪造用户选择，也不要用 markdown 菜单代替 `menu` 的正式 handoff。

### 2c. 歧义评分

每轮回答后，按 `[0.0, 1.0]` 给各维度 clarity 分数并说明缺口。

Greenfield：

`ambiguity = 1 - (intent * 0.30 + outcome * 0.25 + scope * 0.20 + constraints * 0.15 + success * 0.10)`

Brownfield：

`ambiguity = 1 - (intent * 0.25 + outcome * 0.20 + scope * 0.20 + constraints * 0.15 + success * 0.10 + context * 0.10)`

强制 readiness gate：

- `Non-goals` 必须明确
- `Decision Boundaries` 必须明确
- 至少完成一次 pressure pass

即使 weighted ambiguity 已达标，只要上述 gate 未满足，就继续澄清。

### 2d. 透明汇报

每轮后简要展示：

- 当前 weighted ambiguity
- 最弱维度与下一问焦点
- Non-goals / Decision Boundaries / pressure pass 是否已满足
- 剩余关键缺口

### 2e. 轮次控制

- 第一轮不要提供 early exit
- 至少一次假设追问和一次持续 follow-up 后，才允许带风险警告提前退出
- 接近 profile 中点时提醒剩余轮数与主要缺口
- 达到硬上限时必须保留 residual-risk warning

## Phase 3：挑战模式

按需使用，每种模式最多一次：

- **Contrarian / 反证者**：挑战核心假设；适合第 2 轮后或答案依赖未验证假设时
- **Simplifier / 简化者**：逼问最小可行范围；适合范围膨胀快于结果清晰度时
- **Ontologist / 本体追问者**：追问本质诉求；适合用户持续描述症状或 ambiguity > 0.25 时

## Phase 4：收敛与产物

当阈值和 readiness gate 满足，或用户选择带风险退出时，输出澄清总结。总结建议包含：

- clarified goal / 目标
- desired outcome / 期望结果
- in-scope / 本轮范围
- out-of-scope / 非目标
- decision boundaries / 可自主决定与必须回问项
- constraints / 约束
- testable acceptance criteria / 可测试验收标准
- assumptions exposed and resolved / 被暴露并解决的假设
- pressure-pass findings / 压力追问结果
- brownfield evidence vs inference / 代码事实与推断边界
- residual risks / 残余风险（若有）

如宿主支持文件产物，可建议保存：

- `.omx/interviews/{slug}-{timestamp}.md`
- `.omx/specs/deep-interview-{slug}.md`

但在 Ymcp 默认 tool contract 中，这些不是服务端保证生成的 artifact。

## `--autoresearch` 模式说明

该模式用于把需求澄清收敛成 research/mission 类流程可消费的输入。优先澄清：

- mission/topic
- evaluator 如何判断合格
- keep-policy / 保留策略
- slug / 命名约定
- 当前是继续 refine，还是准备进入下游 research

可约定目标产物：

- `.omx/specs/deep-interview-autoresearch-{slug}.md`
- `.omx/specs/autoresearch-{slug}/mission.md`
- `.omx/specs/autoresearch-{slug}/sandbox.md`
- `.omx/specs/autoresearch-{slug}/result.json`

这些在当前仓库中属于规范性目标，不代表 tool 已自动生成。

## Phase 5：进入统一 `menu`

当澄清足够进入下一阶段时：

1. 先输出自然语言澄清总结。
2. 调用统一 `menu` tool：
   - `source_workflow="ydeep"`
   - `summary=<刚输出的澄清总结>`
   - `options=[{"value":"yplan","title":"进入 yplan","description":"基于澄清规格做共识规划","recommended":true}, {"value":"refine_further","title":"继续澄清","description":"仍有关键歧义，回到 deep-interview"}]`

流程菜单阶段以后，下一步动作必须以 `handoff.options` 为唯一权威来源。

## 与原参考工作流的保留/适配差异

保留：量化歧义门、one-question-per-round、stage priority、pressure pass、challenge modes、context snapshot/spec artifact 思路、residual-risk handoff。

适配：Ymcp 公共下一步只通过 `menu` 暴露 `yplan` 与 `refine_further`；更大的外部编排由宿主在该菜单选择之后处理。

## 最终检查清单

- [ ] 已完成上下文预检
- [ ] 每轮只问一个问题
- [ ] 展示或内部维护 ambiguity score
- [ ] Non-goals 明确
- [ ] Decision Boundaries 明确
- [ ] 至少一次 pressure pass
- [ ] Brownfield 问题基于仓库证据
- [ ] 澄清总结包含验收标准与残余风险
- [ ] 未直接实现代码
- [ ] 已调用统一 `menu`，且 `source_workflow="ydeep"`

Task: {{ARGUMENTS}}

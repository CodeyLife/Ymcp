---
name: deep-interview
description: 面向规划或执行前的苏格拉底式需求澄清
argument-hint: "[--quick|--standard|--deep] [--autoresearch] <想法、目标或模糊描述>"
---

# Deep Interview / 深度访谈

## 作用

`deep-interview` 用于在规划或执行前做**意图优先**的需求澄清。

它的目标不是直接实现功能，而是把模糊想法收敛成可交接的、边界清晰的说明：

- 为什么要做这件事
- 想达到什么结果
- 第一阶段到底做多大
- 哪些内容必须明确排除在外
- 哪些决定可以交给 OMX/LLM 自主判断，哪些仍需要用户确认

如果请求还很模糊、验收标准不清楚、边界容易跑偏，优先使用这个 skill。

## 在 Ymcp 中的工作方式

在当前 Ymcp 实现里，`deep-interview` 是一个**skill-flow 方法指导**，不是重型服务端状态机。

真实链路如下：

1. 模型依据本 skill 的方法完成需求澄清
2. 澄清完成并输出总结文案后调用统一 `menu` tool
3. `menu` 参数必须包含 `source_workflow="ydeep"`、总结 `summary`，以及下一步 options（当前合法项为 `yplan` 与 `refine_further`）

请注意：

- `ydeep` **不会**返回结构化“澄清进度面板”
- `ydeep` **不会**返回 clarity score、missing items、gap list 等字段
- 澄清总结由调用 `menu` 时的 `summary` 参数承载
- 下一步动作必须以 `menu` 返回的 `handoff.options` 为唯一权威来源

换句话说：

- **skill 负责澄清方法**
- **tool / host 负责阶段 gate、流程菜单阶段与 handoff 菜单**

## 适用场景

在这些情况下优先使用：

- 请求宽泛、模糊，缺少明确验收标准
- 用户明确表示“先别假设”“先问清楚”“先访谈我”“deep interview”
- 任务容易因为边界不清而误实现
- 在进入 `yplan`、`autopilot`、`ralph`、`team` 前需要先形成需求说明
- 需要把“意图、边界、非目标、约束、验收标准”先收敛清楚

## 不适用场景

这些情况下通常不应使用：

- 任务已经很具体，文件/符号/验收标准都很清楚
- 已经有完整计划或 PRD，应该直接进入后续阶段
- 用户明确要求跳过访谈、立即执行
- 只是轻量 brainstorming，而不是需要澄清约束与边界

## 为什么需要它

很多执行偏差并不是因为“不会做”，而是因为“没有先弄清楚该做什么”。

一次普通扩写常常会漏掉：

- 用户真正想解决的根因
- 第一阶段边界应该停在哪里
- 哪些取舍绝不能做
- 哪些决定仍然需要用户拍板
- 哪些内容虽然相关，但本轮应明确排除

`deep-interview` 的意义，就是在进入规划或实现前，先对这些高风险模糊项施加澄清压力。

## 深度档位

可按任务风险和信息缺失程度选择不同深度：

- **Quick (`--quick`)**
  - 适合快速预检
  - 目标是先补齐最关键的意图、范围、约束缺口
- **Standard (`--standard`, 默认)**
  - 适合大多数需求澄清
  - 要求能形成稳定的规划输入
- **Deep (`--deep`)**
  - 适合高风险、高歧义、边界复杂的任务
  - 会更强调反证、权衡与边界压力测试

如果没有显式指定档位，默认按 **Standard** 处理。

## `--autoresearch` 模式说明

`--autoresearch` 是一个**规范性访谈 / 交接模式**，用于把需求澄清收敛成后续 research/mission 类流程可消费的输入。

在该模式下，访谈应当优先澄清：

- mission/topic 到底是什么
- evaluator 应怎样判断结果是否合格
- keep-policy / 保留策略是什么
- slug / 命名约定是什么
- 当前是应该继续 refine，还是已经准备好进入下游 research 流程

若运行时与下游链路支持，目标产物可约定为：

- `.omx/specs/deep-interview-autoresearch-{slug}.md`
- `.omx/specs/autoresearch-{slug}/mission.md`
- `.omx/specs/autoresearch-{slug}/sandbox.md`
- `.omx/specs/autoresearch-{slug}/result.json`

但要特别注意：

- 以上内容在当前仓库里**只应被描述为规范、约定或目标产物**
- 不应写成“当前仓库已经保证生成这些文件”
- 不应写成“当前系统已经具备 validator evidence 完整闭环”

如果后续要真正实现 `autoresearch` 的 evidence/validator 收敛，那属于独立的 contract / engine / artifact 能力建设，不属于本 skill 文案本身。

## 执行原则

### 1. 一轮只问一个高杠杆问题
不要一轮抛出多个并列问题。每轮只追当前最影响边界、验收或交接质量的那个问题。

### 2. 先问意图和边界，再问实现细节
优先澄清：

- 用户为什么要做
- 最终想得到什么
- 本轮包含什么
- 本轮明确不做什么
- 哪些决定还需要确认

在这些没有稳定前，不要过早下钻实现细节。

### 3. 优先追最弱维度，而不是平均覆盖
不要为了“每类都问一遍”而浅尝辄止。应优先追问当前最弱、最模糊、最容易导致误实现的维度。

### 4. 至少做一次 pressure pass
在准备收敛前，至少回头挑战一次前面答案，做更深一层的压力测试，例如：

- 让用户给出具体例子或反例
- 暴露隐藏假设
- 迫使明确 tradeoff 或排除项
- 把“症状描述”追问到“根因 / 本质诉求”

### 5. Brownfield 先看事实，再问用户偏好
如果是已有仓库上的改动：

- 先看代码事实、已有模式、上下文约束
- 再问“是否沿用现有模式”之类的确认问题

不要把本来可以从仓库里查到的事实问题丢给用户回答。

### 6. 只有在足够清晰时才 handoff
如果意图、边界、非目标、约束、成功标准仍有关键缺口，不要急着 handoff 到下游执行模式。

## 推荐澄清维度

建议围绕这些维度收敛：

- **Intent Clarity / 意图清晰度**
  - 用户真正为什么要做这件事
- **Outcome Clarity / 结果清晰度**
  - 预期最终结果是什么
- **Scope Clarity / 范围清晰度**
  - 第一阶段做到哪里为止
- **Non-goals / 非目标**
  - 哪些内容明确不在本轮范围内
- **Decision Boundaries / 决策边界**
  - 哪些决定 OMX/LLM 可自主判断，哪些必须回问
- **Constraint Clarity / 约束清晰度**
  - 技术、业务、时间、兼容性、安全等限制
- **Success Criteria / 成功标准清晰度**
  - 什么结果才算真正完成
- **Context Clarity / 上下文清晰度**（brownfield 尤其重要）
  - 当前仓库、流程、已有模式、已有 artefact 的事实基础

## 推荐澄清流程

### Phase 0：上下文预检
在提问前，先完成最小上下文整理：

- 任务是什么
- 希望结果是什么
- 已知事实有哪些
- 明显未知项有哪些
- 如果是 brownfield，相关代码/文档/模式是什么

必要时可记录到：

- `.omx/context/`

### Phase 1：初始化澄清方向
确定：

- 当前是 quick / standard / deep 哪种档位
- 当前更像 greenfield 还是 brownfield
- 第一轮应该先打哪一个最弱维度

### Phase 2：苏格拉底式访谈循环
每轮建议结构：

1. 识别当前最弱维度
2. 提一个问题
3. 读取回答
4. 判断是否还需要在同一线程继续追问一层
5. 更新当前对：意图、边界、约束、成功标准的把握

优先顺序建议：

1. Intent / Outcome / Scope / Non-goals / Decision Boundaries
2. Constraints / Success Criteria
3. Brownfield context grounding

### Phase 3：挑战模式（按需）
按需加入这些压力测试视角：

- **Contrarian / 反证者**
  - 挑战当前答案里的核心假设
- **Simplifier / 简化者**
  - 逼问最小可行范围
- **Ontologist / 本体追问者**
  - 当回答一直停留在表象时，追问真正本质诉求

### Phase 4：收敛与产物
当需求已足够清楚时，整理出：

- clarified goal
- in-scope
- out-of-scope / non-goals
- constraints
- decision boundaries
- success criteria
- 必要的 brownfield 事实说明

如果需要产出说明，可约定沉淀到：

- `.omx/interviews/`
- `.omx/specs/`

### Phase 5：进入统一 `menu`
当你认为本轮澄清已经足够进入下一阶段时，先输出澄清总结，然后调用统一 `menu` tool。

调用参数必须包含：

- `source_workflow="ydeep"`
- `summary=<刚输出的澄清总结>`
- `options=[yplan, refine_further]`

## 交接规则

### 1. 只能使用 tool 返回的 handoff 菜单
流程菜单阶段以后，下一步动作必须以 `handoff.options` 为唯一权威来源。

### 2. 当前不要发明额外路由协议
不要自己发明直接跳去 `ydo`、`autopilot` 或其他执行路线，除非 tool 明确提供。

### 3. 如果仍有关键歧义，就走 `refine_further`
如果边界、非目标、约束或成功标准仍不稳，优先在 menu 选项中保留 `refine_further`，而不是强行 handoff。

## 完成提示建议

在调用 `menu` 前，你的总结可优先覆盖这些内容：

- clarified goal
- scope
- non-goals
- constraints
- success criteria
- 任何必须保留给下游的关键边界

自然语言总结必须作为 `menu.summary` 传入；真正的下一步选择仍由 `menu.options` / `handoff.options` 决定。

## 注意事项

- 本 skill 是**澄清模式**，不是实现模式
- 不要在这里直接开始编码或宣称已执行完成
- 如果任务已经非常明确，应尽快 handoff，而不是过度访谈
- 如果任务仍然高歧义，不要因为急于推进而跳过边界确认
- 规范层描述不等于当前 tool 已有结构化字段；不要把方法论写成现有 contract 事实

Task: {{ARGUMENTS}}

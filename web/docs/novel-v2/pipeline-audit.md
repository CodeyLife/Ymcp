# novel-v2 流程审核报告（对照 quality-standard.md）

> 本报告按 pipeline stage 逐段审核，每段对照 `docs/novel-v2/quality-standard.md` 的 5 大维度（D1 世界观 / D2 故事性 / D3 群像 / D4 感情线 / D5 幽默）与可审计判据（W/S/E/R/H）。
> 审核对象：每段的**生成提示词**、**实际产物**、**审核逻辑**、**审核提示词**。
> 缺口按根因层分类：prompt / schema / contract / validation / skill。
> 与 `outputs/novel-v2-framework-audit-2026-07-29.html` 互补：前者审工程可靠性，本报告审文学质量。

## 当前实现基线（2026-08-03）

本节覆盖并取代下方早期审计记录中标为“待修复/future work”的 Foundation 与 Story Arc 结论；历史样本、问题发现和当时的根因分析继续保留，便于追踪迭代来源。

| 原问题编号 | 当前状态 | 代码证据与验证 |
| --- | --- | --- |
| F1 Foundation 审核维度错配 | 已修复 | `prompts/foundation-review.ts` 使用独立 `foundationReviewSchema` 与 D1-D5 五维契约；审核结果写入 review artifact，并绑定当前 artifact fingerprint |
| F2 `reviewGate=none` 默认绕过 | 已修复 | `application/bootstrap.ts` 默认 `manual`；`none` 仅显式传入时生效；核心五项通过 `project_plan_sections` 等待作者确认 |
| F3 Foundation 生成缺少创作意图锚点 | 已修复 | `application/creative-brief.ts` 解析版本化简报，`foundation.ts` 将读者承诺、主题、人物、研究和结局边界注入定位与下游上下文 |
| F5 Story Arc 质量维度和字段不足 | 已修复 | `ChapterBlueprint` 增加 `worldRuleRefs`、`characterFocus`、`romanceTreatment`、`humorTreatment`；章节计划检查矩阵扩展为 11 项 |
| F7 Foundation 上下文传递不足 | 已修复 | `chapter-planning-context.ts` 渲染世界规则、配角欲望/行动/代价、感情线和幽默适用性；Foundation skill bundle fingerprint 进入 artifact |
| F9 章节审核缺少 D1/D3/D4/D5 | 已修复 | 章节 `REVIEW_DIMENSIONS` 当前为 14 项，新增世界观、群像、感情线、幽默及长程叙事辅助维度 |
| F10 commit gate 缺少当前适用维度证据 | 已修复 | `revision-policy.ts` 按冻结章节蓝图接收适用维度并检查 `dimensionScores`/issue evidence；`CommitService` 复核同一契约 |

当前剩余风险不是“是否有字段”，而是实际生成文本是否用这些字段完成了具体叙事，以及外部 PostgreSQL/Temporal smoke 是否可在运行环境中验证。验收必须同时查看 JSON、章节文本、workflow transition、审核 evidence 和最终提交结果。

---

## Stage 1: Foundation（project-positioning / architecture / characters / worldview / relations / plot-threads / foreshadowing / timeline / story-control / plot-design）

### 1.1 审核对象
- **生成提示词**：`src/novel-v2/prompts/foundation.ts`（`TASK_KEY_GUIDANCE` + `buildFoundationPrompt`）
- **实际产物**：spirit-logic-v4-20260729 项目 architecture artifact（`5ca79fb7`，runId `7b47fc8d`）
- **审核逻辑**：`src/novel-v2/temporal/workflows.ts` `processWorkItem` + `creative/review-gate.ts`，Foundation 通过 `review.foundation` 专属审核后再进入门禁
- **审核提示词**：`src/novel-v2/prompts/foundation-review.ts`，不再复用章节正文 reviewer schema

### 1.2 生成提示词审核（历史样本；当前实现见“当前实现基线”）

| 质量判据 | 现状 | 评估 |
|---|---|---|
| **D1-W2 文化/思想承载** | `worldview.focus` L83-89 列 geography/politics/factions/rules/threats，纯机制维度，**未要求设定承载主题或哲思** | **缺口（prompt 层）**：rules 描述为"武功体系/科技水平/魔法规则等"，无主题承载要求。实际产物中"灵气=逻辑本源"有哲思承载，但来自用户 premise 注入，非 prompt 系统性要求 → 跨项目不可复现 |
| **D2-S3 人物驱动因果** | architecture 产物含"支线必须通过改变主线人物的选择、认知或资源而产生实际影响，而非仅作为背景板" | **达标** ✓ — 该判据在产物中明确出现 |
| **D2-S2 伏笔闭环** | `foreshadowing.focus` L109-115 含长/中/短线 + 触发机制 + 回收节点；priority.required 含 `expectedPayoffWindow` | **达标** ✓ |
| **D2-S5 多线可收束** | `plot-threads.focus` L96-102 含主线+支线(3-5)+交织规则；产物含 6 卷 310 章结构 | **达标** ✓ |
| **D3-E1 配角独立欲望** | 历史 prompt 只写功能；当前 prompt 与 semantic contract 要求 fear、independentAction 和 cost | **历史缺口，已修复** |
| **D3-E2 声部可区分** | 历史 voiceAnchor optional；当前 characters contract 将 voiceAnchor 作为必填锚点 | **历史缺口，已修复** |
| **D3-E3 弧光完整** | characters priority.required 含 `arc` | **达标** ✓（schema 层强制 arc） |
| **D4-R1 行动承载** | `plot-threads.focus` L99 仅"情感发展轨迹"，**无行动/细节承载要求** | **缺口（prompt 层）**：感情线描述模糊，无 R1 判据 |
| **D4-R2 阶段性/不可逆** | 未要求感情阶段标记与不可逆性 | **缺口（schema + prompt 层）** |
| **D4-R4 女主独立人格** | characters 无女主独立 arc 强制要求（虽 schema 允许） | **缺口（prompt 层）**：未区分女主设计要求 |
| **D4-R3/R5 与主线交织/复杂度** | `plot-threads.focus` 有"情感线"但 optional；无交织/复杂度判据 | **缺口（schema + prompt 层）**：emotionalLines 在 priority.optional L104 |
| **D5-H1-H4 幽默** | 当前由 `foundationReview`、Story Arc `humorTreatment` 和章节 `humor` 共同覆盖；不适用状态合法 | **已补齐；不要求每个角色或每章强制幽默** |

### 1.3 实际产物审核（历史 architecture artifact 5ca79fb7）

**优点**：
- S3 达标：明确"支线必须改变主角选择/认知/资源"——这是 quality-standard 的 S3 判据
- S2 达标：3 条跨百章伏笔 + 兑现窗口
- 卷功能起承转深合终 + turningPoint 不可逆性（"与庙堂决裂""信念崩塌""失去重要之人"）——优于普通网文
- 视角策略明确（单 POV 为主 + 关键节点切换女主/配角）

**当前边界**：
- D5 幽默：6 卷主题（崛起/博弈/冲突/勘破/牺牲/余韵）全部严肃，**无幽默调节位**。对照《雪中》"小二上酒"的人间烟火与《剑来》朱敛市井机锋——百万字纯严肃会疲劳
- D4 感情线：仅"感情线"作为支线被提及，苏晚意在卷六出现"缱绻情思"，**无 R1-R5 结构化设计**（无阶段标记/无行动承载要求/无女主独立 arc）
- D3 群像：架构层只提"兼顾群像刻画"，**未指定重要配角数量/独立欲望/弧光**（待 characters artifact 审核）
- W2 文化承载："灵气=逻辑本源"有哲思（来自 premise），但 architecture prompt 未要求每卷主题承载文化/哲思

### 1.4 审核逻辑审核（**关键根因层发现**）

**历史发现 F1（contract 层，HIGH，已修复）**：foundation review 维度错配
- 早期 `materializeExternalReview` 使用章节 reviewer schema；这些维度对架构 JSON 不适用。
- **当前修复**：`buildFoundationReviewPrompt` / `FOUNDATION_REVIEW_DIMENSIONS` 已位于 `prompts/foundation-review.ts`，并通过 `foundation-contract.ts` 与 `artifactFingerprint` 做结构和版本校验。
- **历史影响**：foundation 质量曾缺少文学维度度量；现在由专属审核和一致性检查驱动修订。

**历史发现 F2（policy 层，HIGH，已修复）**：reviewGate=none 使 foundation 审核非阻塞
- 早期 bootstrap 将 `reviewGate=none` 作为默认路径，生成后可直接 accept。
- **当前修复**：bootstrap 默认 `manual`；核心五项在 `processWorkItem` 中等待作者确认，`none` 只有显式传入时才跳过门禁。
- **当前边界**：非核心 Foundation 任务仍可按 `auto/manual` 策略自动接受；重大审核问题或上游变更会转人工。

**历史发现 F3（prompt 层，MEDIUM；部分已修复）：foundation 生成质量自检不足**
- `FOUNDATION_SYSTEM_PROMPT`（L321-323）只要求"JSON 结构 + 内在逻辑一致性 + 与前序连贯"，**无质量维度自检**（如"检查你的世界观是否承载主题""检查配角是否有独立欲望"）
- 对比 chapter-draft 有"机械报表识别""长篇耐心"等自检段
- **当前边界**：结构契约和专属 review 已形成硬约束；生成 prompt 仍不替代审核 evidence，后续可继续增加跨题材自检而不把样例短语变成黑名单。

### 1.5 根因层状态（当前基线）

| 项目 | 根因层 | 当前状态与边界 | 优先级 |
|---|---|---|---|
| F1 foundation review 维度错配 | contract | 已修复：专属 `foundationReviewSchema` + D1-D5 + fingerprint 门禁 | 已完成 |
| F2 reviewGate=none 非阻塞 | policy | 已修复：默认 `manual`；`none` 仅显式测试/调试，核心五项还需作者确认 | 已完成 |
| F3 foundation 生成时质量自检 | prompt | 仍是可选增强；结构 contract、专属 review 和作者门禁已覆盖硬约束，不用固定短语黑名单替代审核 | 后续优化 |
| D1/D3/D4/D5 Foundation 规划质量 | contract/review | 已由任务级 contract、专属五维 review、Story Arc 字段和章节适用性 coverage 共同覆盖；具体文本质量仍需回归样本验证 | 已完成基础闭环 |

### 1.6 Stage 1 历史审核结论

历史 Foundation 产物在结构维度较强，但曾缺少文学质量字段和审核门禁。当前实现已在生成层增加语义 contract，在审核层使用专属 `foundationReview`，并通过默认 manual gate 与作者确认阻止核心规划缺陷下沉；实际文本仍需用跨题材样本和 workflow smoke 验证。

**历史推荐**：F1 + F2（审核契约层）> D4 感情线（schema+prompt）> D1-W2 + D3-E2（prompt/schema）。这些项已在当前实现基线中分别落到专属审核、默认门禁、蓝图字段和语义 validator。

---

## Stage 2: Story-Arc（故事弧规划 + 整弧章节蓝图批量生成）

### 2.1 审核对象
- **生成提示词**：`src/novel-v2/prompts/story-arc.ts`（`buildStoryArcPrompt` L91-99 + `buildStoryArcBatchPrompt` L114-126）
- **schema**：`storyArcBundleSchema` L3-33（arc + batch + chapters 三段）+ `storyArcReviewSchema` L35-41
- **审核逻辑**：`src/novel-v2/temporal/workflows.ts` `storyArcPlanningWorkflow` L819-927
- **审核提示词**：`buildStoryArcReviewPrompt` L128-147（含 `STORY_ARC_REVIEW_DIMENSIONS` L56-82，5 维度评分锚点）
- **数据结构**：`src/novel-v2/application/story-arc.ts` `StoryArcBundle` / `ChapterBlueprint` L48-71

### 2.2 生成提示词审核（历史样本；当前实现已补齐质量字段）

**优点**：
- **D2-S1/S4 章节功能与节奏**：`buildStoryArcPrompt` 明确章节蓝图是创作边界而非待办清单，推进、停顿、余波、等待、恢复、相处、内省、气氛、误判、文学意象和日常过程都可以成为章节主体 —— 符合 S4 节奏随功能波动判据
- **长篇层级契约**：story-arc prompt 先区分全书、卷/篇章、故事弧、批次与章节职责；章节可以是停顿、余波、等待、恢复、日常、气氛、误判或关系沉淀，不要求每章都有新信息、新压力、新爽点或主线推进。
- **窗口级退化审核**：story-arc review 通过 `longform-function` 在逐章层保护合法安静章，并通过 `longform-hierarchy` / `window-variation` 在整弧层检查局部蓝图是否吞掉上层规划、连续章节是否机械复用同一关键词/场景压力/反应逻辑。
- **D2-S3 人物驱动**：`STORY_ARC_REVIEW_DIMENSIONS` 的"人物空间"维度（L78-82）要求"主角在本弧有欲望—行动—情感的弧线；配角有承担功能而非工具人"
- **Foundation 与 Story Arc 都有独立 review prompt**：前者审核项目级架构，后者审核故事弧与逐章蓝图，二者不复用章节正文 reviewer schema

**缺口**：

| 质量判据 | 现状 | 评估 |
|---|---|---|
| **D1-W1/W3 世界观一致** | 当前章节蓝图要求 `worldRuleRefs`，Story Arc review 检查引用和代价 | **已补齐；空引用必须明确本章不调用新规则** |
| **D3-E1 配角独立欲望** | 当前 `characterFocus` 要求配角自身欲望、行动和代价；review 使用 `ensemble-agency` | **已补齐** |
| **D3-E3/E5 弧光/日常质地** | 当前 blueprint 保留 `characterFocus`，并允许安静章/关系章不强行推进 | **已补齐基础契约；长程弧光仍需文本回归** |
| **D4-R1~R5 感情线** | 当前 `romanceTreatment` 记录适用性、阶段、行动证据和边界；review 使用 `romance-arc` | **已补齐；not-applicable 合法** |
| **D5-H1~H4 幽默** | 当前 `humorTreatment` 记录机会、情境证据和边界；review 使用 `humor-fit` | **已补齐；不强制每章插入笑点** |
| **D2-S2 伏笔闭环** | schema arc 含 `foreshadowingRefs`，chapters 含 `setupRefs`/`payoffRefs` | **达标** ✓ |

### 2.3 schema 审核（历史缺口记录；当前字段已补齐）

**arc 字段**：title/objective/entryState/centralConflict/development/resolution/exitState/plotThreadRefs/foreshadowingRefs/expectedChapterCount/phases —— 结构完整，支持弧级规划。

**chapters 字段**：index/title/summary/chapterPurpose/dramaticQuestion/emotionalMovement/stateDeltaBudget/optionalBeats/scenes/continuityConstraints/setupRefs/payoffRefs/closingForce/freedom —— 章节级规划字段较丰富。

当前质量字段：`worldRuleRefs`、`characterFocus`、`romanceTreatment`、`humorTreatment` 均为章节 schema 必填；`emotionalMovement` 继续作为章节情绪变化的自然语言摘要，不替代上述可执行字段。

### 2.4 审核逻辑审核（历史问题与当前边界）

**storyArcPlanningWorkflow（历史审计行号已随实现变化）**：
- `reviewPolicy` 默认：`params.reviewPolicy ?? (params.mode === "mcp" ? "auto" : "manual")` —— web 模式默认 manual，mcp 模式默认 auto
- **auto 模式流程**（L902-919）：generateBundle → reviewBundle → if `verdict=passed && !blocking` → approveStoryArcAutomatically；否则 reviseBundle（最多 maxRetries=2 次）；超限 → failStoryArc → manual-review-required
- **当前 manual 模式流程**：generateBundle → reviewBundle → 写入 advisory review → 等待人工 signal → completed；review 仍供作者参考，不会绕过人工确认。

**历史发现 F4（policy 层，MEDIUM，已修复）**：manual 模式无 advisory review
- web 默认 manual 模式下，generateBundle 后直接等待人工批准，**不生成 advisory review**
- 作者手动批准时无审核参考——质量完全依赖作者判断
- 对比 auto 模式有 reviewBundle 辅助，manual 模式反而无
- **影响**：web 作者批准 story-arc 时可能放过 D1/D3/D4/D5 缺口（因无 review 提示）
- **当前状态**：manual 分支已先执行 `reviewBundle` 并将 review artifact/status 写入 workflow，再等待作者批准；以下内容保留为历史根因记录。

**历史发现 F5（contract 层，HIGH，已修复）**：story-arc review 维度不足
- `STORY_ARC_REVIEW_DIMENSIONS` 只有 5 维度：因果闭合/状态连续/提前消费检测/机械逐项检测/人物空间
- 对照 quality-standard.md 5 大维度：
  - D1 世界观：**无审核维度**（不查规则一致性/主题承载）
  - D3 群像：只查"配角有功能"（弱化 E1），**不查独立欲望/弧光/关系网络**（E1/E3/E4/E5 缺）
  - D4 感情线：**完全无审核维度**（R1-R5 全缺）
  - D5 幽默：**完全无审核维度**（H1-H4 全缺）
- 虽有独立 review prompt（优于 foundation），但维度不足仍让文学质量缺口无法被度量
- **影响**：即使 story-arc 产出感情线/幽默/群像薄弱，review 也无法报告 → auto 模式下 verdict=passed → 缺陷下沉到章节 draft
- **当前状态**：章节蓝图已结构化承接 `worldRuleRefs`、`characterFocus`、`romanceTreatment`、`humorTreatment`，`CHAPTER_PLAN_CHECK_DIMENSIONS` 已扩展并由 validator 检查；本段旧字段清单不再是当前契约。

**当前对比 Foundation**：
- 两个阶段都使用独立 review prompt 和当前产物绑定；Foundation 面向项目级架构，Story Arc 面向弧与章节蓝图。
- Story Arc 的 `CHAPTER_PLAN_CHECK_DIMENSIONS` 与 `ChapterBlueprint` 字段负责把 D1/D3/D4/D5 下沉到章节；Foundation review 负责上游方向性门禁。
- 剩余风险是模型是否给出真实 evidence，以及长文本回归能否发现结构化字段没有被正文使用。

### 2.5 审核提示词审核（当前边界）

**buildStoryArcReviewPrompt L128-147**：
- **优点**：有独立审核维度 + 5/3/1 评分锚点 + issue 证据要求（"必须引用章节编号+逐字片段或 JSON 路径"，L139）+ severity 判定规则（L140）
- **当前边界**：
  - D1/D3/D4/D5 已由蓝图字段、计划检查和审核提示共同覆盖；`not-applicable` 状态不会被当成缺陷。
  - `longform-function` 保护安静章、铺陈章、关系章不因缺少显性主线推进而误判；窗口级维度继续检查重复退化。

### 2.6 根因层分类与修复方向（历史记录）

| 缺口 | 根因层 | 修复方向（待 S3 实施） | 优先级 |
|---|---|---|---|
| F4 manual 模式无 advisory review | policy | 已修复：manual 分支先生成 advisory review，再等待作者确认 | MEDIUM → 已修复 |
| F5 story-arc review 维度不足 | contract | 已修复：字段、11 项计划检查和专属 Story Arc review 共同覆盖 D1/D3/D4/D5 | HIGH → 已修复 |
| D1 世界观无下沉 | schema + prompt | 已修复：`ChapterBlueprint.worldRuleRefs` 与规则代价检查 | MEDIUM → 已修复 |
| D3 群像无下沉 | schema + prompt | 已修复：`characterFocus` 要求配角欲望、行动和代价 | MEDIUM → 已修复 |
| D4 感情线无下沉 | schema + prompt | 已修复：`romanceTreatment` 使用适用性、阶段和行动证据 | HIGH → 已修复 |
| D5 幽默无下沉 | schema + prompt | 已修复：`humorTreatment` 使用适用性、机会和情境证据 | LOW → 已修复 |

### 2.7 Stage 2 历史审核结论

Story-arc 阶段**结构上优于 foundation**：有独立 review prompt、审核门有效（auto/manual 模式均审校）、schema 字段较丰富。早期版本曾存在 D1 世界观/D3 群像深度/D4 感情线/D5 幽默下沉不足；当前已通过蓝图字段、计划检查和章节上下文投影落地，后续重点是 evidence 质量和实际文本回归。

**历史关键根因**：F5（review 维度不足）曾是 lowest shared layer。当前 `CHAPTER_PLAN_CHECK_DIMENSIONS` 已加入世界观、群像、感情线、幽默检查，蓝图字段也已下沉；后续重点是 evidence 质量和实际文本回归。

---

## Stage 3: Blueprint（执行蓝图编译 + 蓝图注入到 draft）

### 3.1 审核对象
- **blueprint 编译逻辑**：`src/novel-v2/cognition.ts` `compileExecutionBlueprint` L295-333
- **blueprint 数据结构**：`ExecutionBlueprint`（含 tasks/memoryGate/budget/foundationArtifactIds/arcId/chapterBlueprintId/planningContextFingerprint）
- **blueprint 注入到 draft**：`src/novel-v2/prompts/chapter-draft.ts` `buildChapterDraftPrompt` L422-515 + `buildBlueprintSummary`
- **foundation 注入**：`buildFoundationContextMarkdown` L114-170
- **planning context 注入**：`renderChapterPlanningContext`（chapter-planning-context.ts L7-62）

### 3.2 blueprint 编译逻辑审核

**compileExecutionBlueprint L295-333**：
- 构建的 `ExecutionBlueprint` 字段：id/projectId/intentId/preflightId/memoryBundleId/skillBundleId/contextManifestId/baseRevision/tasks(retrieve/draft/review/commit)/commitPolicy/factApprovalMode/budget/memoryGate/foundationArtifactIds/arcId/chapterBlueprintId/planningContextFingerprint
- **发现 F6（contract 层，by design）：blueprint 无质量维度字段**
  - `ExecutionBlueprint` 是"执行编排"层，只持有引用（ids）和任务依赖，**不持有任何质量维度字段**
  - 质量维度全靠 `ChapterPlanningContext`（来自 story-arc 的 `ChapterBlueprint`）+ `foundationArtifacts` + `writer-rules` 注入
  - **这是 design by design**：blueprint 是执行层，不是内容规划层。但问题是 `ChapterBlueprint`（story-arc 产物）的质量字段不足（见 Stage 2 schema 审核）→ 缺陷从 story-arc 经 blueprint 传递到 draft
  - **修复方向**：不改 `ExecutionBlueprint`（它是执行层），改 `ChapterBlueprint` schema 让质量字段从 story-arc 传递到 draft

### 3.3 blueprint 注入到 draft 审核

**buildChapterDraftPrompt L422-515**：
- 注入顺序：WRITER_HARD_CONSTRAINTS → WRITER_LONGFORM_AXIS → POV → mustHappen/forbidden → WRITER_SCENE_AND_CHARACTER → WRITER_DIALOGUE_AND_DETAIL → WRITER_PACING_AND_LONGFORM_RESERVE → 章尾形态 → WRITER_LANGUAGE_AND_LENGTH → payoffStats → foundationArtifacts → planningContext → blueprintMarkdown → contextMarkdown → skills → 意图 → WRITER_GENERATION_SELF_CHECK → WRITER_FINAL_CHECK

**优点**：
- writer-rules（writer-rules.ts 175 行）非常详尽，覆盖：
  - D3 群像：声部指纹（L92-93）、对白差异化（L88-90）、配角抉择瞬间（L77）、多角色入场差异化（L81-82）
  - D2 故事性：长篇轴（L63-64）、节奏与余量（L105-110）、章尾钩子十型（L115-132）
  - D4 感情线技法：潜台词优先（L90）、情感重场戏环境替角色说话（L74）
- `buildChapterDraftPromptPackage` L527-549 用 `compileStageContext` 构建结构化 prompt package（含 priority/provenanceRefs），支持 prompt 上下文审计

**缺口**：

| 质量判据 | 现状 | 评估 |
|---|---|---|
| **D1-W1 世界观一致** | `worldRuleRefs` 与 Foundation `worldview.rules` 都进入冻结上下文 | **已补齐输入契约**；正文是否遵守仍由 reflection/reviewer 验证 |
| **D3-E2 声部与独立行动** | Foundation renderer 投影 `voiceAnchor`/`independentAction`，章节 `characterFocus` 声明本章行动与代价 | **已补齐输入契约**；不强制每章加入配角 |
| **D4-R1/R2 感情线** | `romanceTreatment` 投影状态、阶段、行动证据和边界 | **已补齐输入契约**；`not-applicable` 不触发章节门禁 |
| **D5-H1/H3 幽默** | `humorTreatment` 投影机会、情境证据和边界 | **已补齐输入契约**；不强制插入笑料 |

### 3.4 foundation 注入审核（buildFoundationContextMarkdown L114-170）

**当前渲染字段**：
- architecture: structure/povStrategy/timeSpan/volumes
- characters: name/role/motivation/voiceAnchor/independentAction（仅投影通用结构化字段）
- worldview: rules/factions，规则项包含 statement/cost/boundary
- plot-design: narrativePromises/nonNegotiables/adaptationTriggers/endingEnvelope
- 不再注入静态 `chapter-plan`；章节级字段由 `ChapterPlanningContext` 单独投影

**历史发现 F7（prompt 层，MEDIUM，已修复）**：Foundation `characters.voiceAnchor` 曾未渲染；当前 renderer 同时投影 `voiceAnchor` 和 `independentAction`，并由 `foundation-context-projection.test.ts` 验证。

### 3.5 ChapterPlanningContext 注入审核（renderChapterPlanningContext L7-62）

**渲染内容**：arc(title/objective/entryState/centralConflict/development/resolution/exitState) + chapter(summary/chapterPurpose/dramaticQuestion/povCharacterId/emotionalMovement/stateDeltaBudget/narrativeScale/closingForce/freedom/continuityConstraints/setupRefs/payoffRefs/optionalBeats/scenes) + neighbors + macroPlanArtifacts + 约束优先级

**优点**：
- 冻结章节规划上下文较完整，含章节功能/戏剧问题/情绪运动/状态变化预算/章尾驱动力/自由度/约束优先级
- `narrativeScale` 把章节展开深度、同一功能的 `developmentAxes` 与 `stoppingCondition` 传入正文；`standard` 只作为普通完整章节体量参考，不转化为字数门槛。
- L60 明确"目标章功能、状态变化预算、连续性约束、人物知识边界和故事弧离场边界是硬约束。宏观节奏、其他剧情线与可选节拍是软参考"

**篇幅根因修复（2026-08-03）**：此前章节蓝图只有事件结果边界，没有叙事规模契约；writer 又被要求“完成即收束、不得为延长篇幅重复”，导致模型在单一场景完成首个状态变化后采用最小充分输出。现改为由规划层声明 `compact/standard/extended` 及同一功能内部的展开轴，旧蓝图缺失该字段时由运行时按 `standard` 软信号兼容归一化，writer 以连续体验补足深度，reviewer 以 `chapter.premature-closure` 检查提前收束；字符数仍不是审核目标。

**当前状态**：
- `worldRuleRefs`、`characterFocus`、`romanceTreatment`、`humorTreatment` 已结构化渲染。
- `emotionalMovement` 保留为摘要，不替代上述可执行字段；`not-applicable` 是合法状态。

### 3.6 根因层分类与修复方向（当前边界）

| 项目 | 根因层 | 当前状态 | 优先级 |
|---|---|---|---|
| F6 ExecutionBlueprint 无质量字段 | contract (by design) | **不改 blueprint**（它是执行层）；由 `ChapterBlueprint` 与 planning context 传递质量字段 | 按设计保留 |
| F7 voiceAnchor 未渲染 | prompt | 已修复：`buildFoundationContextMarkdown` 的 `characters` case 渲染 voiceAnchor | MEDIUM → 已修复 |
| D1 世界观自检缺失 | prompt | `WRITER_GENERATION_SELF_CHECK` 加"写到世界观规则时，检查本章是否遵守 foundation 已确立规则" | MEDIUM |
| D4 感情线自检缺失 | prompt | `WRITER_GENERATION_SELF_CHECK` 加"写到感情进展时，检查是否用行动/细节承载而非心理总结；检查女主是否有独立选择" | HIGH |
| D5 幽默自检缺失 | prompt | `WRITER_GENERATION_SELF_CHECK` 加"写到幽默时，检查是否贴合人物性格而非硬抖包袱" | LOW |

### 3.7 Stage 3 审核结论

Blueprint 阶段是"传递层"而非"规划层"——它本身不产生质量维度，只传递 foundation + story-arc + writer-rules 的质量要求到 draft。当前 `renderChapterPlanningContext` 已渲染世界规则、配角独立行动、感情线和幽默适用性；下方关于 F7 的描述属于历史快照。

**关键约束**：blueprint 阶段的质量取决于上游（foundation + story-arc）的 schema 字段是否完整。当前链路为：Foundation contract → ChapterBlueprint contract → `renderChapterPlanningContext` → draft/review prompt；`not-applicable` 状态保留题材和章节功能的自由度。

---

## 跨 Stage 1-3 根因层汇总

| 根因层 | 发现 | 影响 | 修复优先级 |
|---|---|---|---|
| contract | F1 foundation review 维度错配 | foundation 文学质量无法度量 | 已修复 |
| policy | F2 foundation reviewGate=none 非阻塞 | foundation 缺陷下沉 | 已修复 |
| prompt | F3 foundation 无质量自检 | LLM 无质量自觉 | MEDIUM |
| policy | F4 story-arc manual 模式无 advisory review | web 作者无审核参考 | 已修复 |
| contract | F5 story-arc review 维度不足 | story-arc 文学质量部分无法度量 | 已修复 |
| contract | F6 ExecutionBlueprint 无质量字段（by design） | 质量靠上游 schema 传递 | HIGH（联动 Stage 2） |
| prompt | F7 voiceAnchor 未渲染到 draft | D3-E2 声部区分无依据 | 已修复 |
| schema | D4 感情线无字段（foundation + story-arc + blueprint 全链） | R1-R5 全缺，感情线质量无结构化支撑 | 已修复 |
| schema | D1 世界观无下沉字段 | 弧内/章节世界观一致性无保证 | 已修复 |
| schema | D3 群像无下沉字段 | 配角出场/弧光无规划 | 已修复 |
| schema | D5 幽默无字段 | 幽默调节无规划位 | 已修复 |

**历史 S3 修复推荐顺序**（当前状态以顶部基线为准）：Foundation 审核契约 → Story Arc 质量字段 → Blueprint 上下文投影 → manual advisory review；上述主链已落地，剩余是生成质量回归和可选自检增强。

---

## Stage 6: Reflection（草稿后前置自检）

### 6.1 审核对象
- **schema**：`reflectionSchema`（`src/novel-v2/prompts/schemas.ts` L570-626）+ `REFLECTION_DIMENSIONS`（L570-585，14 维度）
- **生成提示词**：`buildChapterReflectionPrompt`（`src/novel-v2/prompts/chapter-reflection.ts` L64-158）
- **维度锚点**：`REFLECTION_DIMENSION_ANCHORS`（chapter-reflection.ts L42-51）

### 6.2 schema 审核

**REFLECTION_DIMENSIONS 14 维度**：pace/emotion/suspense/dialogue/density/trope/language/blueprint/subtext/narrativePacing/worldbuilding/ensemble/romance/humor

> **F8 修复后更新**：REFLECTION_DIMENSIONS 已从 8 维度扩展为 14 维度，新增 worldbuilding/ensemble/romance/humor（对照 D1/D3/D4/D5）+ subtext/narrativePacing（主题显隐维度）。详见下方「F8 修复记录」段。

对照 quality-standard.md 5 大维度（F8 修复后状态）：
- **D1 世界观**：原无专门维度 → **已修复**：worldbuilding 维度覆盖世界观一致性/主题承载
- **D2 故事性**：pace + suspense + blueprint + narrativePacing 覆盖 S1/S4，S2 伏笔闭环/S5 多线可收束仍无专门维度
- **D3 群像**：原 dialogue 仅查"声部混淆" → **已修复**：ensemble 维度覆盖 E1 配角独立欲望/E3 弧光/E4 关系网络
- **D4 感情线**：原 emotion 泛化（"是否能引发读者共情"） → **已修复**：romance 维度覆盖 R1 行动承载/R2 阶段性/R4 女主独立
- **D5 幽默**：原完全无维度 → **已修复**：humor 维度覆盖幽默贴合度

### 6.3 生成提示词审核

**buildChapterReflectionPrompt L64-158**：
- **优点**：严苛读者+资深编辑双视角；issue 必须引用原文片段；rewriteExample 必填（schema 强制 minLength=1）；severity 判定标准清晰（blocker=弃书/major=跳读/warning=可优化）
- **历史缺口已关闭**：当前 `REFLECTION_DIMENSION_ANCHORS` 已包含 worldbuilding、ensemble、romance、humor、subtext、narrativePacing；仍需通过生成文本回归确认模型是否提供真实证据。

**发现 F8（contract 层，MEDIUM）：reflection 维度不覆盖文学质量 5 维度** —— **已修复**
- REFLECTION_DIMENSIONS 原 8 维度全是"读者体验层面"，无 D1 世界观/D3 群像深度/D4 感情线结构/D5 幽默的专门维度
- reflection 是 draft 后的前置自检，维度缺失意味着这些质量维度在 draft 后仍无自检
- **影响**：D1/D3/D4/D5 缺口从 foundation→story-arc→blueprint→draft 全链传递，reflection 仍不拦截 → 缺陷进入正式 5 reviewer 审核
- **修复后**：REFLECTION_DIMENSIONS 扩展为 14 维度，新增 worldbuilding/ensemble/romance/humor + subtext/narrativePacing，reflection 现能拦截 D1/D3/D4/D5 缺陷

### 6.4 根因层分类与修复方向

| 缺口 | 根因层 | 修复方向 | 优先级 |
|---|---|---|---|
| F8 reflection 维度不覆盖 5 维度 | contract | `REFLECTION_DIMENSIONS` 扩展 worldbuilding/ensemble/romance/humor + subtext/narrativePacing 维度（**已修复**，14 维度） | MEDIUM → 已修复 |

### 6.5 Stage 6 审核结论

Reflection 阶段当前使用 14 个维度（pace/emotion/suspense/dialogue/density/trope/language/blueprint/subtext/narrativePacing/worldbuilding/ensemble/romance/humor），作为 draft 后的前置自检覆盖 D1/D3/D4/D5；它仍是辅助门，不能替代正式 reviewer 与 commit gate。

---

## Stage 7: Five-Reviewer（5 章节审校者正式审核）

### 7.1 审核对象
- **schema**：`reviewerSchema` + 14 项 `REVIEW_DIMENSIONS` + `reviewerSchemaForDimensions`（均位于 `src/novel-v2/prompts/schemas.ts`）
- **reviewer 角色**：`REVIEWER_DIMENSIONS`（`src/novel-v2/prompts/chapter-review.ts` L24-30，5 角色 × 维度映射）
- **审核职责**：`DEFAULT_REVIEW_FOCUS`（chapter-review.ts L39-45）
- **审核提示词**：`buildChapterReviewPrompt`（chapter-review.ts L219-322）
- **commit gate**：`evaluateCommitGate`（`src/novel-v2/temporal/revision-policy.ts` L79-107）

### 7.2 schema 审核（REVIEW_DIMENSIONS L16-25）

**14 维度**：plot / characterVoice / sceneEmbodiment / dialogue / specificity / hookPayoff / continuity / readerRetention / worldbuilding / ensemble / romance / humor / subtext / narrativePacing。

对照 quality-standard.md 5 大维度（F9 修复后状态）：
- **D1 世界观**：原无专门维度 → **已修复**：worldbuilding 维度分配给 continuity-reviewer（W1 规则自洽/W2 主题承载/W4 独立质地）
- **D2 故事性**：plot + hookPayoff 覆盖 S1/S4（章节功能/章尾驱动力），不新增维度
- **D3 群像**：原 characterVoice/dialogue 只查单角色声部 → **已修复**：ensemble 维度分配给 character-reviewer（E1/E3/E4/E5）
- **D4 感情线**：原完全无维度 → **已修复**：romance 维度分配给 reader-reviewer（R2 阶段性/R5 复杂度；R1/R4 由 character 现有维度间接覆盖）
- **D5 幽默**：原完全无维度 → **已修复**：humor 维度分配给 style-reviewer（H1 贴合人物/H2 时代契合/H3 调节功能）

### 7.3-7.6 审核结论（简述，详见 ledger Loop 4）

- **7.3 职责审核**：character-reviewer 原 L41 "配角不强制每人拥有独立抉择"与 E1 冲突 → **已修复**（DEFAULT_REVIEW_FOCUS 调整为"重要配角应有自己的欲望、抉择与弧光"）
- **7.4 提示词审核**：原维度边界约束"你只能把 X 维度的问题写入 issues"——若 D4/D5 无对应维度，任何 reviewer 都不会报告 → **已修复**（REVIEWER_DIMENSIONS 分配新维度 + buildChapterReviewPrompt 添加长篇文学质量维度审核提示）
- **7.5 根因层分类**：F9（contract 层，REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5）是全流程审核瓶颈
- **7.6 结论**：F9 是 lowest shared layer，修复后联动 F10（commit gate）

## Stage 8: Revision（修订决策与 commit gate）

### 8.1-8.5 审核结论（简述，详见 ledger Loop 4）

- **decideRevision**（revision-policy.ts L119-174）：基于 scoreReviews（REVIEW_DIMENSIONS 评分）+ hasBlocker/hasMajor
- **evaluateCommitGate**（L79-107）：检查 5 reviewers verdict + overallScore ≥ 4.0 + 单 reviewer ≥ 3.5
- **历史发现 F10（policy 层，HIGH）**：修订决策只依赖 REVIEW_DIMENSIONS 评分；当前已补充按章节适用性的 coverage 检查。
- **当前 F10 修复**：`toReview` 持久化职责维度分数，`evaluateCommitGate` 对当前 artifact 检查适用维度的分数或 issue evidence，`CommitService` 做最终复核。

---

## F9 修复记录（S3，2026-07-31）

### 修复内容

F9（REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5）是全流程审核瓶颈——无论 foundation/story-arc/blueprint/draft/reflection 阶段有多少质量要求，最终都经 5 reviewer 度量。修复在 5 处同步修改，形成完整闭环：

1. **schema 层**（`schemas.ts` REVIEW_DIMENSIONS）：8 维度 → 14 维度，新增 worldbuilding/ensemble/romance/humor + subtext/narrativePacing。注：最初计划扩展为 12 维度（仅 D1/D3/D4/D5 对应 4 维度），最终追加 subtext（主题显隐/潜台词）与 narrativePacing（长篇叙事节奏）两维度，形成 14 维度，更完整覆盖长篇文学质量。
2. **映射层**（`chapter-review.ts` REVIEWER_DIMENSIONS）：4 新维度分配给职责最匹配的 reviewer
   - worldbuilding → continuity-reviewer（规则一致性是 continuity 的延伸）
   - ensemble → character-reviewer（群像深度是人物审核的延伸）
   - romance → reader-reviewer（感情线阶段性影响追更体验）
   - humor → style-reviewer（幽默是语言风格的延伸）
3. **职责层**（`chapter-review.ts` DEFAULT_REVIEW_FOCUS）：4 角色 supplement 新维度审核职责 + 调整 character-reviewer 配角措辞（与 E1 对齐）
4. **技能层**（`chapter-review.ts` REVIEW_ROLE_TERMS）：补充 humor/ensemble/romance/worldbuilding 术语，让 skill 选择能匹配新维度
5. **提示层**（`chapter-review.ts` buildChapterReviewPrompt）：为负责新维度的 reviewer 添加"长篇文学质量维度审核提示"段落（跨章视角 + 结构性缺陷判 major）

### 为什么覆盖更广的失败类（AGENTS.md 要求）

- **原根本因**：REVIEW_DIMENSIONS 是全流程审核的共享契约层，8 维度完全不覆盖 D1/D3/D4/D5，导致审核层无法度量长篇文学质量 → 缺陷带病通过 commit gate → 永久化到 fact/memory
- **修复后**：14 维度覆盖单章可读性 + 长篇文学质量，5 reviewer 各自负责匹配维度，审核层能度量并驱动迭代
- **覆盖的失败类**：世界观规则冲突 / 配角工具化 / 感情线跳阶 / 幽默破坏声部 这 4 类长篇缺陷，原流程无法拦截，现在可被对应 reviewer 报告为 major，触发修订
- **不覆盖**：F3（生成时的额外自检）和 F6（ExecutionBlueprint 不重复存储文学字段）仍是后续优化；当前结构化 contract、上下文投影和正式审核门已覆盖主要失败类。

### 联动修复

- **F10（commit gate 只依赖 REVIEW_DIMENSIONS 评分）**：已补充适用维度 coverage。`toReview` 用 `REVIEWER_DIMENSIONS[role]` 提取分数，`evaluateCommitGate` 检查当前 reviewer 的 dimension score 或 issue evidence，`CommitService` 做最终复核。
- **F8（reflection 维度不覆盖 5 维度）**：**已修复**（详见下方「F8 修复记录」段）。REFLECTION_DIMENSIONS 已扩展为 14 维度，新增 worldbuilding/ensemble/romance/humor + subtext/narrativePacing，reflection 现与 REVIEW_DIMENSIONS 同步覆盖 D1/D3/D4/D5 + 主题显隐维度。

### 回归验证

- `npx vitest run src/novel-v2` → 40 files / 282 passed / 38 skipped（0 failed）
- `npx tsc --noEmit` → 无 novel-v2 类型错误
- 修改的测试：prompts.test.ts（makeReviewerOutput scores 14 维度 + style 维度边界断言 + 测试名 "14"）、chapter-review-snapshot.test.ts（responsibilities 14 维度 + dimensionScores 断言 + overallScore 43/14）

### Tradeoffs / Regression Risks

- **reviewer 负载变化**：style 4 维度 / character 3 维度 / continuity 2 / plot 2 / reader 3。character-reviewer 从 2→3 维度（+ensemble），style-reviewer 从 3→4 维度（+subtext），reader-reviewer 从 2→3 维度（+narrativePacing）。
- **romance 给 reader-reviewer 而非 character-reviewer**：R1 行动承载/R4 女主独立的技法问题由 character/style 现有维度间接覆盖，reader-reviewer 从追更视角判断阶段感/复杂度。权衡：避免 character-reviewer 4 维度过重。
- **prompt 变长**：4 个 reviewer 的 DEFAULT_REVIEW_FOCUS 各增加一段新维度职责。必要——没有职责定义 reviewer 无法审核新维度。
- **selectReviewerMemory 未修改**：reader-reviewer 的 romance 维度可能需要感情线历史记忆，当前只看 chapter-memory/author-preference/style。标记为 future work（可通过类似 payoffStats 的机制注入感情线阶段记忆）。

---

## F8 修复记录（S3，2026-08-01）

### 修复内容

F8（REFLECTION_DIMENSIONS 不覆盖 D1/D3/D4/D5）是 reflection 阶段的审核契约缺口——reflection 作为 draft 后的前置自检，原 8 维度全是"读者体验层面"，无世界观/群像/感情线/幽默的专门维度，导致 D1/D3/D4/D5 缺陷在 draft 后仍无自检，继续下沉到正式 5 reviewer 审核。修复将 REFLECTION_DIMENSIONS 从 8 维度扩展为 14 维度，与 REVIEW_DIMENSIONS 同步覆盖长篇文学质量：

1. **schema 层**（`schemas.ts` REFLECTION_DIMENSIONS）：8 维度 → 14 维度，新增 worldbuilding/ensemble/romance/humor（对照 D1/D3/D4/D5）+ subtext/narrativePacing（主题显隐维度）。完整列表：pace/emotion/suspense/dialogue/density/trope/language/blueprint/subtext/narrativePacing/worldbuilding/ensemble/romance/humor
2. **锚点层**（`chapter-reflection.ts` REFLECTION_DIMENSION_ANCHORS）：为 6 个新维度补判定锚点
   - subtext → 主题显隐与潜台词（正文是否越过 thematicTreatment 权限，用总结/说教/传声筒替读者宣布主题）
   - narrativePacing → 叙事过程与铺陈（关键过程是否真正发生并获得相称篇幅，是否用分析/设定说明跳过人物接触与选择）
   - worldbuilding → 世界观一致性（正文是否违反已建立世界规则、是否有独立世界质地）
   - ensemble → 群像深度（配角是否有独立欲望与选择、是否工具人）
   - romance → 感情线结构（感情发展是否有行动承载、是否有阶段感与不可逆性）
   - humor → 幽默调节（是否有适合题材的幽默调节、是否自然不刻意）
3. **提示层**（`chapter-reflection.ts` buildChapterReflectionPrompt）：维度锚点列表与 dimension 字段说明同步为 14 维度

### 为什么覆盖更广的失败类（AGENTS.md 要求）

- **原根本因**：REFLECTION_DIMENSIONS 是 reflection 阶段的共享契约层，原 8 维度完全不覆盖 D1/D3/D4/D5，导致 draft 后前置自检无法度量长篇文学质量 → 缺陷继续下沉到正式审核层（增加修订成本）或带病通过（若 5 reviewer 也漏报）
- **修复后**：14 维度覆盖读者体验 + 主题显隐 + 长篇文学质量，reflection 现能在 draft 后前置拦截 D1/D3/D4/D5 缺陷，与 REVIEW_DIMENSIONS 形成双层质量门
- **覆盖的失败类**：世界观规则冲突 / 配角工具化 / 感情线跳阶 / 幽默破坏声部 / 主题说教化 / 关键过程被摘要跳过 这 6 类缺陷，原 reflection 无法自检，现在可在 draft 后被报告并驱动 revision
- **不覆盖**：生成层（foundation/story-arc/blueprint/draft）的 schema/prompt 缺口（F3/F6/F7）仍需修复；reflection 是前置自检，正式拦截仍由 5 reviewer + commit gate 保障

### 联动修复

- **F9（REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5）**：F8 与 F9 共享同一组质量维度（D1/D3/D4/D5）。F9 修复正式审核层，F8 修复前置自检层，两层现同步覆盖文学质量，形成 draft→reflection→reviewer→commit 全链质量门。
- **章节审校工作流复用**（AGENTS.md）：chapterReviewWorkflow 的 review→revise 链路在 review-stage 半截启动时复用 reflection activity，REFLECTION_DIMENSIONS 扩展后该复用链同样获得 14 维度自检能力。

### 回归验证

- `npx tsc --noEmit` → 无 novel-v2 类型错误
- `npx vitest run src/novel-v2` → 48 files / 386 passed / 38 skipped；1 failed（`prompts.test.ts > buildChapterDraftPrompt > keeps chapter-relevant foundations`，foundation 上下文选择相关，与 F8 维度扩展无关）
- 维度相关测试通过：chapter-review-snapshot.test.ts（responsibilities 14 维度 + overallScore 43/14）、prompts.test.ts（reflection 14 维度锚点 + makeReviewerOutput scores 14 维度）

### Tradeoffs / Regression Risks

- **reflection 维度数翻倍**：8 → 14 维度。但 reflection 是单次 LLM 调用且"按草稿实际选择相关维度提 issue"，无相关问题的维度不输出 issue，不强制每维度必出 issue，负载可控。
- **subtext/narrativePacing 与 REVIEW_DIMENSIONS 重叠**：reflection 与 REVIEW_DIMENSIONS 现共享 subtext/narrativePacing 两维度。这是有意为之——reflection 做前置自检、reviewer 做正式审核，同一维度双层检查符合"双层质量门"设计；两者锚点措辞不同（reflection 偏读者直觉，reviewer 偏跨章结构性判断）。
- **未新增 reflection→revision 的维度映射逻辑**：reflection issue 的 dimension 字段已对齐 reviewerSchema（含 14 维度枚举），revise 阶段按 issue.rule 命中 skill 的机制对新维度自动生效，无需额外映射。

---

## 跨 Stage 1-8 根因层汇总

| 根因层 | 发现 | 影响 | 状态 |
|---|---|---|---|
| contract | F1 foundation review 维度错配 | foundation 文学质量无法度量 | 已修复（见顶部基线） |
| policy | F2 foundation reviewGate=none 非阻塞 | foundation 缺陷下沉 | 已修复（见顶部基线；none 仅调试） |
| prompt | F3 foundation 无质量自检 | LLM 无质量自觉 | 未修复（future work） |
| policy | F4 story-arc manual 模式无 advisory review | web 作者无审核参考 | 已修复（见顶部基线） |
| contract | F5 story-arc review 维度不足 | story-arc 文学质量部分无法度量 | 已修复（见顶部基线） |
| contract | F6 ExecutionBlueprint 无质量字段（by design） | 质量靠上游 schema 传递 | 未修复（future work） |
| prompt | F7 voiceAnchor 未渲染到 draft | D3-E2 声部区分无依据 | 已修复（见顶部基线） |
| contract | F8 reflection 维度不覆盖 5 维度 | draft 后自检不拦截文学质量缺陷 | **已修复**（REFLECTION_DIMENSIONS 扩展为 14 维度） |
| contract | **F9 REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5** | **5 reviewer 无法度量文学质量** | **已修复（S3）** |
| policy | **F10 修订决策只依赖 REVIEW_DIMENSIONS** | **D1/D3/D4/D5 缺陷可带病通过 commit gate** | **已修复（章节适用维度 coverage + CommitService 复核）** |

---

## 剩余 stages 与 future work

### 未审核 stages（4/5/9/10/11/12）

F9 修复后，剩余 stages 的审核价值递减——它们都是 F9 的上下游，F9 作为 lowest shared layer 已联动全流程。标记为 future work：

- **Stage 4 preflight/context**：ContextManifest 是否选择质量相关记忆。F9 修复后，即使 preflight 未选择质量记忆，5 reviewer 仍能基于正文 + 冻结上下文审核。future work：preflight 可主动选择感情线/群像/世界观相关记忆注入对应 reviewer。
- **Stage 5 draft**：实际产物审核（D1/D3/D4/D5 退化检测）。F9/F10 修复后，draft 退化会被 5 reviewer 和适用维度 coverage 拦截。future work：draft 阶段的生成 prompt 自检（F3）。
- **Stage 9 commit**：commit gate 已在 Stage 8 审核，并由 `CommitService` 以同一适用维度集合做最终复核。
- **Stage 10 fact-extraction**：事实提取质量。F9 修复后，缺陷不会通过 commit gate 进入 fact 阶段。future work：fact-extraction 的 D1 世界观规则提取质量。
- **Stage 11 memory**：chapter memory 质量。F9 修复后，缺陷不会通过 commit gate 进入 memory 阶段。future work：memory 的感情线/群像记忆持久化。
- **Stage 12 learning/promote**：经验沉淀闭环。future work：learning.underlyingMechanism 是否覆盖 D1/D3/D4/D5 机制。

## Stage 8: Revision（修订决策与执行）

### 8.1 审核对象
- **修订决策**：`decideRevision`（`src/novel-v2/temporal/revision-policy.ts` L119-174）
- **commit gate**：`evaluateCommitGate`（revision-policy.ts L79-107）
- **评分函数**：`scoreReviews`（revision-policy.ts L47-59）
- **阈值常量**：`DEFAULT_MAX_AUTO_REVISIONS=2` / `MIN_IMPROVEMENT_THRESHOLD=0.15` / `MIN_AUTOMATIC_COMMIT_SCORE=4.0` / `MIN_REVIEWER_SCORE=3.5`

### 8.2 修订决策审核（decideRevision L119-174）

**决策规则**：
- `allReviewsPassed && !belowQualityScore` → 不修订
- `iteration >= maxIterations` → 停止（进入人工队列）
- `blocker` → 必须修订
- `belowQualityScore` → 修订
- `!major` → 不修订
- `improvement < 0.15` → 停止（避免无限循环）
- else → 修订

**优点**：
- 改善度阈值 0.15 避免无限循环
- 综合分 + 单 reviewer 分双门槛（4.0 + 3.5）
- blocker 强制修订
- 决策理由（reason）完整记录

**历史发现 F10（policy 层，HIGH，已修复）：修订决策只依赖 REVIEW_DIMENSIONS 评分，无质量维度独立门**
- `decideRevision` 基于 `scoreReviews`（综合分）+ `hasBlocker`/`hasMajor`，但 score 来自 REVIEW_DIMENSIONS 的 8 维度
- `evaluateCommitGate` 同样只检查 `REQUIRED_CHAPTER_REVIEWERS` 的 verdict + score
- 若 D4 感情线/D5 幽默无维度（F9），即使感情线/幽默完全缺失，score 仍可能 ≥ 4.0 → verdict=passed → commit
- **影响**：F9（REVIEW_DIMENSIONS 缺口）+ F10（决策只依赖这些维度）= D1/D3/D4/D5 缺陷可带病通过 commit gate → 缺陷进入 fact/memory 永久化
- **当前状态**：正式章节 workflow 从冻结 `ChapterBlueprint` 计算适用维度，commit gate 检查当前 reviewer 的 `dimensionScores` 或 issue evidence；`CommitService` 以同一维度集合再次复核。感情线、幽默标记为 `not-applicable` 时不会加入硬门槛。

### 8.3 commit gate 审核（evaluateCommitGate L79-107）

**优点**：
- 检查 5 reviewers 全到位（`REQUIRED_CHAPTER_REVIEWERS` L3-9：plot/continuity/style/character/reader）
- 检查 verdict=passed + 无 blocker/major + 综合分 ≥ 4.0 + 单 reviewer ≥ 3.5
- `missingRoles` 报告

**当前状态**：
- `evaluateCommitGate` 检查当前 artifact 的五角色证据、适用维度覆盖、局部质量门和结构门；缺少适用维度证据时返回 `qualityFailure=dimension-coverage`。
- `CommitService` 复用相同 options 做最终复核，避免 workflow 之外的直接提交绕过维度检查。

### 8.4 根因层分类与修复方向

| 缺口 | 根因层 | 修复方向 | 优先级 |
|---|---|---|---|
| F10 修订决策只依赖 REVIEW_DIMENSIONS | policy | 已修复：`evaluateCommitGate` 增加按章节适用性的维度覆盖检查，并由 `CommitService` 二次复核 | HIGH → 已修复 |

### 8.5 Stage 8 审核结论

Revision 阶段的决策逻辑（改善度阈值/blocker 强制/双分门槛）继续保留；当前在最终 commit gate 增加了按章节适用性的维度覆盖检查，形成“评分 + evidence + 结构”三重门。局部退化仍由现有 `MAX_REVIEWER_SCORE_DROP` 与最佳候选回退逻辑保护。

---

## 跨 Stage 1-8 根因层汇总（更新）

| 根因层 | 发现 | 影响 | 修复优先级 |
|---|---|---|---|
| contract | F1 foundation review 维度错配 | foundation 文学质量无法度量 | 已修复 |
| policy | F2 foundation reviewGate=none 非阻塞 | foundation 缺陷下沉 | 已修复 |
| prompt | F3 foundation 无质量自检 | LLM 无质量自觉 | MEDIUM |
| policy | F4 story-arc manual 模式无 advisory review | web 作者无审核参考 | 已修复 |
| contract | F5 story-arc review 维度不足 | story-arc 文学质量部分无法度量 | 已修复 |
| contract | F6 ExecutionBlueprint 无质量字段（by design） | 质量靠上游 schema 传递 | HIGH（联动 Stage 2） |
| prompt | F7 voiceAnchor 未渲染到 draft | D3-E2 声部区分无依据 | 已修复 |
| contract | F8 reflection 维度不覆盖 5 维度 | draft 后自检不拦截 D1/D3/D4/D5 | **已修复**（14 维度） |
| contract | **F9 REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5** | **5 reviewer 无法度量文学质量** | **HIGH（最关键）** |
| policy | F10 修订决策只依赖 REVIEW_DIMENSIONS | D1/D3/D4/D5 缺陷可带病通过 commit gate | 已修复（适用维度覆盖） |
| schema | D4 感情线无字段（foundation + story-arc + blueprint 全链） | R1-R5 全缺 | 已修复 |
| schema | D1 世界观无下沉字段 | 弧内/章节世界观一致性无保证 | 已修复 |
| schema | D3 群像无下沉字段 | 配角出场/弧光无规划 | 已修复 |
| schema | D5 幽默无字段 | 幽默调节无规划位 | 已修复 |

**历史 S3 修复推荐顺序**（当前状态）：F9/F10、F1/F2、F5/D4、F8、F7、F4 均已完成；剩余重点是 F3 生成时自检、F6 是否需要额外蓝图质量快照，以及真实长文本回归。

**关键洞察（历史→当前）**：F9 曾是全流程审核瓶颈；当前 14 维度、章节适用性 coverage、局部退化守卫和最终 commit 复核共同构成质量门。分数仍不能替代文本和 workflow artifact 的人工验收。

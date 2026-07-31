# novel-v2 流程审核报告（对照 quality-standard.md）

> 本报告按 pipeline stage 逐段审核，每段对照 `docs/novel-v2/quality-standard.md` 的 5 大维度（D1 世界观 / D2 故事性 / D3 群像 / D4 感情线 / D5 幽默）与可审计判据（W/S/E/R/H）。
> 审核对象：每段的**生成提示词**、**实际产物**、**审核逻辑**、**审核提示词**。
> 缺口按根因层分类：prompt / schema / contract / validation / skill。
> 与 `outputs/novel-v2-framework-audit-2026-07-29.html` 互补：前者审工程可靠性，本报告审文学质量。

---

## Stage 1: Foundation（project-positioning / architecture / characters / worldview / relations / plot-threads / foreshadowing / timeline / story-control / plot-design）

### 1.1 审核对象
- **生成提示词**：`src/novel-v2/prompts/foundation.ts`（`TASK_KEY_GUIDANCE` + `buildFoundationPrompt`）
- **实际产物**：spirit-logic-v4-20260729 项目 architecture artifact（`5ca79fb7`，runId `7b47fc8d`）
- **审核逻辑**：`src/novel-v2/temporal/workflows.ts` `processPlan` L1090-1210 + `checkGate` L1148
- **审核提示词**：无独立 foundation review prompt；复用 `chapter-review.ts` 的 5 章节审校者

### 1.2 生成提示词审核（对照 quality-standard.md）

| 质量判据 | 现状 | 评估 |
|---|---|---|
| **D1-W2 文化/思想承载** | `worldview.focus` L83-89 列 geography/politics/factions/rules/threats，纯机制维度，**未要求设定承载主题或哲思** | **缺口（prompt 层）**：rules 描述为"武功体系/科技水平/魔法规则等"，无主题承载要求。实际产物中"灵气=逻辑本源"有哲思承载，但来自用户 premise 注入，非 prompt 系统性要求 → 跨项目不可复现 |
| **D2-S3 人物驱动因果** | architecture 产物含"支线必须通过改变主线人物的选择、认知或资源而产生实际影响，而非仅作为背景板" | **达标** ✓ — 该判据在产物中明确出现 |
| **D2-S2 伏笔闭环** | `foreshadowing.focus` L109-115 含长/中/短线 + 触发机制 + 回收节点；priority.required 含 `expectedPayoffWindow` | **达标** ✓ |
| **D2-S5 多线可收束** | `plot-threads.focus` L96-102 含主线+支线(3-5)+交织规则；产物含 6 卷 310 章结构 | **达标** ✓ |
| **D3-E1 配角独立欲望** | `characters.focus` L58-63 含"各自动机"但措辞为"在故事中的功能"，**未要求欲望与主角不一致** | **部分缺口（prompt 层）**：动机存在但可能工具化为"功能" |
| **D3-E2 声部可区分** | `characters.structuredDataHint` voiceAnchor {sentenceLength, vocabulary, directness, avoidance}；priority **optional** | **缺口（schema 层）**：voiceAnchor 可选 → LLM 可省略 → 声部区分无保证 |
| **D3-E3 弧光完整** | characters priority.required 含 `arc` | **达标** ✓（schema 层强制 arc） |
| **D4-R1 行动承载** | `plot-threads.focus` L99 仅"情感发展轨迹"，**无行动/细节承载要求** | **缺口（prompt 层）**：感情线描述模糊，无 R1 判据 |
| **D4-R2 阶段性/不可逆** | 未要求感情阶段标记与不可逆性 | **缺口（schema + prompt 层）** |
| **D4-R4 女主独立人格** | characters 无女主独立 arc 强制要求（虽 schema 允许） | **缺口（prompt 层）**：未区分女主设计要求 |
| **D4-R3/R5 与主线交织/复杂度** | `plot-threads.focus` 有"情感线"但 optional；无交织/复杂度判据 | **缺口（schema + prompt 层）**：emotionalLines 在 priority.optional L104 |
| **D5-H1-H4 幽默** | foundation prompt **完全无幽默维度**；voiceAnchor 无 humor 字段 | **缺口（prompt + schema 层）**：幽默在架构层可能可接受，但 voiceAnchor 应含幽默风格以支撑 H1 |

### 1.3 实际产物审核（architecture artifact 5ca79fb7）

**优点**：
- S3 达标：明确"支线必须改变主角选择/认知/资源"——这是 quality-standard 的 S3 判据
- S2 达标：3 条跨百章伏笔 + 兑现窗口
- 卷功能起承转深合终 + turningPoint 不可逆性（"与庙堂决裂""信念崩塌""失去重要之人"）——优于普通网文
- 视角策略明确（单 POV 为主 + 关键节点切换女主/配角）

**缺口**：
- D5 幽默：6 卷主题（崛起/博弈/冲突/勘破/牺牲/余韵）全部严肃，**无幽默调节位**。对照《雪中》"小二上酒"的人间烟火与《剑来》朱敛市井机锋——百万字纯严肃会疲劳
- D4 感情线：仅"感情线"作为支线被提及，苏晚意在卷六出现"缱绻情思"，**无 R1-R5 结构化设计**（无阶段标记/无行动承载要求/无女主独立 arc）
- D3 群像：架构层只提"兼顾群像刻画"，**未指定重要配角数量/独立欲望/弧光**（待 characters artifact 审核）
- W2 文化承载："灵气=逻辑本源"有哲思（来自 premise），但 architecture prompt 未要求每卷主题承载文化/哲思

### 1.4 审核逻辑审核（**关键根因层发现**）

**发现 F1（contract 层，HIGH）：foundation review 维度错配**
- `materializeExternalReview`（activities.ts L569-575）使用 `reviewerSchemaForDimensions(REVIEWER_DIMENSIONS[input.role])` —— 这是 **5 章节审校者维度**（sceneEmbodiment/specificity/characterVoice/dialogue/continuity/plot/hookPayoff/readerRetention）
- 这些维度是**正文质感维度**，对架构 JSON 不适用：sceneEmbodiment 检查场景具象，但 architecture 是结构化数据；characterVoice 检查对白声部，但 characters 是档案 JSON
- 全代码库无 `buildFoundationReviewPrompt` / `FOUNDATION_REVIEW_DIMENSIONS`（已搜索确认）
- **影响**：foundation 质量无文学维度度量。世界观深度/群像设计/感情线结构/幽默规划**无法被审核层度量**，即使生成层产出薄弱也无法触发修订

**发现 F2（policy 层，HIGH）：reviewGate=none 使 foundation 审核非阻塞**
- workflows.ts L1105 注释明确："foundation 阶段 reviewGate='none'（bootstrap_run 配置），生成后 gate 直接 passed → accept"
- `processPlan` L1148-1153：gate.passed → acceptWork，**不等待 review**
- fullbook Loop 5 的"9/10 independent review passed"是 **advisory review**（外部 MCP 提交但不阻塞 accept），非硬门
- **影响**：即使 F1 修复（加入 foundation 维度），reviewGate=none 仍让 review 不阻塞 → foundation 可带病通过 → 缺陷下沉到章节生成阶段才暴露（成本更高）

**发现 F3（prompt 层，MEDIUM）：foundation 生成无质量自检指令**
- `FOUNDATION_SYSTEM_PROMPT`（L321-323）只要求"JSON 结构 + 内在逻辑一致性 + 与前序连贯"，**无质量维度自检**（如"检查你的世界观是否承载主题""检查配角是否有独立欲望"）
- 对比 chapter-draft 有"机械报表识别""长篇耐心"等自检段
- **影响**：LLM 生成 foundation 时无质量维度自觉，完全依赖下游 review（而 review 又是 F1/F2 的薄弱状态）

### 1.5 根因层分类与修复方向（为 S3 修复做准备）

| 缺口 | 根因层 | 修复方向（待 S3 实施） | 优先级 |
|---|---|---|---|
| F1 foundation review 维度错配 | contract | 新增 foundation 专用 reviewer 角色（如 worldview-critic/ensemble-critic/romance-critic/humor-critic）或在 closed-loop 加 foundation review prompt 映射架构字段到质量维度 | HIGH |
| F2 reviewGate=none 非阻塞 | policy | bootstrap 默认 reviewGate 改为 manual/auto（生产模式）；保留 none 仅用于调试。framework audit 2026-07-29 第 3 节 P1 已提"规划默认缺质量审核" | HIGH |
| F3 foundation 无质量自检 | prompt | FOUNDATION_SYSTEM_PROMPT 追加质量维度自检段（对照 quality-standard.md 5 维度） | MEDIUM |
| D1-W2 世界观主题承载 | prompt | `worldview.focus` 追加"核心规则须承载主题或哲思（如秩序/创造/因果），非纯力量机制" | MEDIUM |
| D3-E2 voiceAnchor optional | schema | characters schema 把 voiceAnchor 从 optional 提升为 required（至少主角+重要配角） | MEDIUM |
| D4-R1-R5 感情线 | schema + prompt | plot-threads schema 把 emotionalLines 从 optional 提升为 required；focus 追加 R1(行动承载)/R2(阶段性)/R4(女主独立) 判据 | HIGH |
| D5-H1 幽默 | prompt + schema | voiceAnchor 加 humorStyle 字段；foundation 追加"识别可承载幽默的人物与情境"focus | LOW（架构层） |

### 1.6 Stage 1 审核结论

Foundation 生成层在**结构维度**（伏笔/多线/卷功能/不可逆转折）达标，但**文学质量维度**（世界观主题承载/群像独立/感情线结构/幽默规划）有系统性缺口。更关键的是**审核层根因**（F1/F2）：foundation review 复用章节审校者维度 + reviewGate=none 非阻塞，使文学质量缺口无法在 foundation 阶段被度量与拦截，缺陷必下沉到章节生成阶段才暴露。

**推荐 S3 修复优先级**：F1 + F2（审核契约层）> D4 感情线（schema+prompt）> D1-W2 + D3-E2（prompt/schema）。F1/F2 是 lowest shared layer，修复后能驱动后续 foundation 质量迭代；只修生成 prompt 而不修审核层，则 LLM 仍可绕过质量要求。

---

## Stage 2: Story-Arc（故事弧规划 + 整弧章节蓝图批量生成）

### 2.1 审核对象
- **生成提示词**：`src/novel-v2/prompts/story-arc.ts`（`buildStoryArcPrompt` L91-99 + `buildStoryArcBatchPrompt` L114-126）
- **schema**：`storyArcBundleSchema` L3-33（arc + batch + chapters 三段）+ `storyArcReviewSchema` L35-41
- **审核逻辑**：`src/novel-v2/temporal/workflows.ts` `storyArcPlanningWorkflow` L819-927
- **审核提示词**：`buildStoryArcReviewPrompt` L128-147（含 `STORY_ARC_REVIEW_DIMENSIONS` L56-82，5 维度评分锚点）
- **数据结构**：`src/novel-v2/application/story-arc.ts` `StoryArcBundle` / `ChapterBlueprint` L48-71

### 2.2 生成提示词审核（对照 quality-standard.md）

**优点**：
- **D2-S1/S4 章节功能与节奏**：`buildStoryArcPrompt` L95 明确"章节蓝图是创作边界，不是待办清单。铺陈、相处、内省、情绪积累、文学意象和日常过程可以成为章节主体" —— 符合 S4 节奏随功能波动判据
- **D2-S3 人物驱动**：`STORY_ARC_REVIEW_DIMENSIONS` 的"人物空间"维度（L78-82）要求"主角在本弧有欲望—行动—情感的弧线；配角有承担功能而非工具人"
- **有独立 story-arc review prompt**（优于 foundation 的 F1：foundation 无独立 review prompt）—— story-arc 阶段有专属审核维度与锚点

**缺口**：

| 质量判据 | 现状 | 评估 |
|---|---|---|
| **D1-W1/W3 世界观一致** | story-arc prompt 无世界观一致性要求；`storyArcBundleSchema.arc` 字段含 `plotThreadRefs`/`foreshadowingRefs` 但**无 `worldRuleRefs`** | **缺口（schema + prompt 层）**：弧内章节是否遵守已确立世界观规则无审核 |
| **D3-E1 配角独立欲望** | `STORY_ARC_REVIEW_DIMENSIONS` "人物空间"只要求"配角有承担功能而非工具人"——这是 E1 的弱化版，**未要求配角独立欲望/与主角不一致** | **缺口（contract 层）**：review 维度只查"功能"不查"独立欲望" |
| **D3-E3/E5 弧光/日常质地** | schema chapters 无配角出场规划字段；review 无弧光完整性维度 | **缺口（schema + contract 层）** |
| **D4-R1~R5 感情线** | story-arc prompt **完全无感情线规划**；schema 无 `romanceStage`/感情行动承载字段；review 无感情线维度 | **缺口（schema + prompt + contract 层）**：D4 在 story-arc 阶段完全缺失，foundation 的 D4 缺口下沉且放大 |
| **D5-H1~H4 幽默** | story-arc prompt 无幽默规划；schema 无 `humorOpportunity` 字段；review 无幽默维度 | **缺口（schema + prompt + contract 层）** |
| **D2-S2 伏笔闭环** | schema arc 含 `foreshadowingRefs`，chapters 含 `setupRefs`/`payoffRefs` | **达标** ✓ |

### 2.3 schema 审核（storyArcBundleSchema L3-33）

**arc 字段**：title/objective/entryState/centralConflict/development/resolution/exitState/plotThreadRefs/foreshadowingRefs/expectedChapterCount/phases —— 结构完整，支持弧级规划。

**chapters 字段**：index/title/summary/chapterPurpose/dramaticQuestion/emotionalMovement/stateDeltaBudget/optionalBeats/scenes/continuityConstraints/setupRefs/payoffRefs/closingForce/freedom —— 章节级规划字段较丰富。

**缺口（质量维度字段缺失）**：
- 无 `worldRuleRefs`（D1 世界观规则引用——本章涉及哪些世界观规则需遵守）
- 无 `characterFocus`（D3 群像——本章哪些配角有戏份/弧光推进/独立抉择）
- 无 `romanceStage`（D4 感情线阶段标记+行动承载要求）
- 无 `humorOpportunity`（D5 幽默调节位——本章是否有幽默空间）
- `emotionalMovement` 是 string，无结构化阶段（只是描述性文字）

### 2.4 审核逻辑审核

**storyArcPlanningWorkflow L819-927**：
- `reviewPolicy` 默认：`params.reviewPolicy ?? (params.mode === "mcp" ? "auto" : "manual")` —— web 模式默认 manual，mcp 模式默认 auto
- **auto 模式流程**（L902-919）：generateBundle → reviewBundle → if `verdict=passed && !blocking` → approveStoryArcAutomatically；否则 reviseBundle（最多 maxRetries=2 次）；超限 → failStoryArc → manual-review-required
- **manual 模式流程**（L895-900）：generateBundle → 等待人工 signal → completed，**不执行 reviewBundle**

**发现 F4（policy 层，MEDIUM）：manual 模式无 advisory review**
- web 默认 manual 模式下，generateBundle 后直接等待人工批准，**不生成 advisory review**
- 作者手动批准时无审核参考——质量完全依赖作者判断
- 对比 auto 模式有 reviewBundle 辅助，manual 模式反而无
- **影响**：web 作者批准 story-arc 时可能放过 D1/D3/D4/D5 缺口（因无 review 提示）

**发现 F5（contract 层，HIGH）：story-arc review 维度不足**
- `STORY_ARC_REVIEW_DIMENSIONS` 只有 5 维度：因果闭合/状态连续/提前消费检测/机械逐项检测/人物空间
- 对照 quality-standard.md 5 大维度：
  - D1 世界观：**无审核维度**（不查规则一致性/主题承载）
  - D3 群像：只查"配角有功能"（弱化 E1），**不查独立欲望/弧光/关系网络**（E1/E3/E4/E5 缺）
  - D4 感情线：**完全无审核维度**（R1-R5 全缺）
  - D5 幽默：**完全无审核维度**（H1-H4 全缺）
- 虽有独立 review prompt（优于 foundation），但维度不足仍让文学质量缺口无法被度量
- **影响**：即使 story-arc 产出感情线/幽默/群像薄弱，review 也无法报告 → auto 模式下 verdict=passed → 缺陷下沉到章节 draft

**对比 Stage 1 的 F1/F2**：
- story-arc 的审核门**有效**（auto 模式 blocker/major 触发 revise，非 none）——优于 foundation 的 F2
- story-arc 有独立 review prompt ——优于 foundation 的 F1
- 但 review 维度不足（F5）——与 foundation 的 F1 同类问题（维度错配/缺失），只是程度较轻

### 2.5 审核提示词审核

**buildStoryArcReviewPrompt L128-147**：
- **优点**：有独立审核维度 + 5/3/1 评分锚点 + issue 证据要求（"必须引用章节编号+逐字片段或 JSON 路径"，L139）+ severity 判定规则（L140）
- **缺口**：
  - 维度本身不足（见 F5）
  - 无"安静章/铺陈章不应因无推进判错"的明确保护（只在 dimension 锚点中隐含"不要因安静章、铺陈章、关系章没有明显推进主线而判错" L136，但未与 D4/D5 缺口联动）

### 2.6 根因层分类与修复方向

| 缺口 | 根因层 | 修复方向（待 S3 实施） | 优先级 |
|---|---|---|---|
| F4 manual 模式无 advisory review | policy | web manual 模式在人工批准前也生成 advisory review（不阻塞，只辅助作者决策） | MEDIUM |
| F5 story-arc review 维度不足 | contract | `STORY_ARC_REVIEW_DIMENSIONS` 扩展 D1(世界观一致)/D3(群像深度)/D4(感情线结构)/D5(幽默调节) 维度 | HIGH |
| D1 世界观无下沉 | schema + prompt | `ChapterBlueprint` schema 加 `worldRuleRefs`；story-arc prompt 要求引用世界观规则 | MEDIUM |
| D3 群像无下沉 | schema + prompt | `ChapterBlueprint` schema 加 `characterFocus`（配角戏份/弧光推进）；story-arc prompt 要求规划配角出场 | MEDIUM |
| D4 感情线无下沉 | schema + prompt | `ChapterBlueprint` schema 加 `romanceStage`；story-arc prompt 要求规划感情阶段；对照 R1(行动承载)/R2(阶段性)/R4(女主独立) | HIGH |
| D5 幽默无下沉 | schema + prompt | `ChapterBlueprint` schema 加 `humorOpportunity`；story-arc prompt 识别可承载幽默的情境 | LOW |

### 2.7 Stage 2 审核结论

Story-arc 阶段**结构上优于 foundation**：有独立 review prompt、审核门有效（auto 模式）、schema 字段较丰富。但**文学质量维度仍有系统性缺口**：D1 世界观/D3 群像深度/D4 感情线/D5 幽默在 schema、prompt、review 维度三层均缺失。特别是 D4 感情线——foundation 阶段已缺失，story-arc 阶段仍无下沉，缺陷将持续传递到章节 draft。

**关键根因**：F5（review 维度不足）是 lowest shared layer。即使补 schema/prompt 字段，若 review 不度量这些维度，auto 模式下仍 verdict=passed → 缺陷下沉。S3 修复应优先 F5 + D4 schema/prompt，再补 D1/D3/D5。

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
| **D1-W1 世界观一致自检** | `WRITER_GENERATION_SELF_CHECK` L147-158 无"检查本章是否遵守已确立世界观规则" | **缺口（prompt 层）**：writer 无世界观一致性自觉 |
| **D3-E2 声部** | writer-rules 有声部要求（L92-93），但 `buildFoundationContextMarkdown` **不渲染 voiceAnchor**（L207-214 只渲染 name/role/motivation） | **缺口（prompt 层）**：即使 foundation schema 有 voiceAnchor，draft prompt 也不含声部信息 → LLM 无声部依据 |
| **D4-R1 行动承载自检** | `WRITER_GENERATION_SELF_CHECK` 无感情线行动承载自检；`WRITER_SCENE_AND_CHARACTER` L74 提"情感重场戏优先让环境替角色说话"是技法非质量维度 | **缺口（prompt 层）**：感情线质量无自检 |
| **D4-R2 阶段性** | 无感情阶段标记注入（因 ChapterBlueprint 无 romanceStage） | **缺口（schema + prompt 层）**：承接 Stage 2 的 D4 缺口 |
| **D4-R4 女主独立** | 无女主独立 arc 注入 | **缺口（schema + prompt 层）** |
| **D5-H1 幽默自检** | `WRITER_DIALOGUE_AND_DETAIL` L92 提"声音指纹"但**无幽默风格要求**；无幽默自检钩子 | **缺口（prompt 层）** |

### 3.4 foundation 注入审核（buildFoundationContextMarkdown L114-170）

**渲染字段**：
- architecture: structure/povStrategy/timeSpan/volumes
- characters: name/role/motivation —— **不渲染 voiceAnchor**
- worldview: rules/factions —— **不渲染主题承载**
- plot-design: opening/climax/ending
- chapter-plan: 前 5 章

**发现 F7（prompt 层，MEDIUM）：foundation characters voiceAnchor 未渲染**
- `renderFoundationFields` L207-214 的 `characters` case 只提取 `name`/`role`/`motivation`，**未提取 `voiceAnchor`**（sentenceLength/vocabulary/directness/avoidance）
- 即使 foundation schema 的 voiceAnchor 是 optional（Stage 1 的 D3-E2 缺口），当 LLM 填充了 voiceAnchor 时，draft prompt 也拿不到
- **影响**：D3-E2 声部区分在 draft 阶段无依据 → writer 只能凭冻结上下文 claim 推导声部，效力弱

### 3.5 ChapterPlanningContext 注入审核（renderChapterPlanningContext L7-62）

**渲染内容**：arc(title/objective/entryState/centralConflict/development/resolution/exitState) + chapter(summary/chapterPurpose/dramaticQuestion/povCharacterId/emotionalMovement/stateDeltaBudget/closingForce/freedom/continuityConstraints/setupRefs/payoffRefs/optionalBeats/scenes) + neighbors + macroPlanArtifacts + 约束优先级

**优点**：
- 冻结章节规划上下文较完整，含章节功能/戏剧问题/情绪运动/状态变化预算/章尾驱动力/自由度/约束优先级
- L60 明确"目标章功能、状态变化预算、连续性约束、人物知识边界和故事弧离场边界是硬约束。宏观节奏、其他剧情线与可选节拍是软参考"

**缺口**：
- 无 `worldRuleRefs` 渲染（D1）——因 ChapterBlueprint schema 无此字段
- 无 `characterFocus` 渲染（D3 群像）——因 schema 无此字段
- 无 `romanceStage` 渲染（D4）——因 schema 无此字段
- 无 `humorOpportunity` 渲染（D5）——因 schema 无此字段
- `emotionalMovement` 是 string，无结构化阶段

### 3.6 根因层分类与修复方向

| 缺口 | 根因层 | 修复方向（待 S3 实施） | 优先级 |
|---|---|---|---|
| F6 ExecutionBlueprint 无质量字段 | contract (by design) | **不改 blueprint**（它是执行层）；改 `ChapterBlueprint` schema 让质量字段从 story-arc 传递到 draft | HIGH（通过 Stage 2 schema 修复联动） |
| F7 voiceAnchor 未渲染 | prompt | `buildFoundationContextMarkdown` 的 `characters` case 加 `voiceAnchor` 渲染（sentenceLength/vocabulary/directness/avoidance） | MEDIUM |
| D1 世界观自检缺失 | prompt | `WRITER_GENERATION_SELF_CHECK` 加"写到世界观规则时，检查本章是否遵守 foundation 已确立规则" | MEDIUM |
| D4 感情线自检缺失 | prompt | `WRITER_GENERATION_SELF_CHECK` 加"写到感情进展时，检查是否用行动/细节承载而非心理总结；检查女主是否有独立选择" | HIGH |
| D5 幽默自检缺失 | prompt | `WRITER_GENERATION_SELF_CHECK` 加"写到幽默时，检查是否贴合人物性格而非硬抖包袱" | LOW |

### 3.7 Stage 3 审核结论

Blueprint 阶段是"传递层"而非"规划层"——它本身不产生质量维度，只传递 foundation + story-arc + writer-rules 的质量要求到 draft。writer-rules 在 D3 群像技法/D2 故事性/D4 感情线技法层面覆盖较好，但**自检钩子缺失**（D1 世界观/D4 感情线/D5 幽默无自检）+ **foundation 渲染缺口**（F7 voiceAnchor 未渲染）。

**关键根因**：blueprint 阶段的质量取决于上游（foundation + story-arc）的 schema 字段是否完整。Stage 1/2 的 D1/D3/D4/D5 schema 缺口会经 blueprint 无损传递到 draft。S3 修复应联动：Stage 2 的 ChapterBlueprint schema 加质量字段 → Stage 3 的 renderChapterPlanningContext 渲染这些字段 → draft prompt 能拿到质量维度。

---

## 跨 Stage 1-3 根因层汇总

| 根因层 | 发现 | 影响 | 修复优先级 |
|---|---|---|---|
| contract | F1 foundation review 维度错配 | foundation 文学质量无法度量 | HIGH |
| policy | F2 foundation reviewGate=none 非阻塞 | foundation 缺陷下沉 | HIGH |
| prompt | F3 foundation 无质量自检 | LLM 无质量自觉 | MEDIUM |
| policy | F4 story-arc manual 模式无 advisory review | web 作者无审核参考 | MEDIUM |
| contract | F5 story-arc review 维度不足 | story-arc 文学质量部分无法度量 | HIGH |
| contract | F6 ExecutionBlueprint 无质量字段（by design） | 质量靠上游 schema 传递 | HIGH（联动 Stage 2） |
| prompt | F7 voiceAnchor 未渲染到 draft | D3-E2 声部区分无依据 | MEDIUM |
| schema | D4 感情线无字段（foundation + story-arc + blueprint 全链） | R1-R5 全缺，感情线质量无结构化支撑 | HIGH |
| schema | D1 世界观无下沉字段 | 弧内/章节世界观一致性无保证 | MEDIUM |
| schema | D3 群像无下沉字段 | 配角出场/弧光无规划 | MEDIUM |
| schema | D5 幽默无字段 | 幽默调节无规划位 | LOW |

**S3 修复推荐顺序**（按根因层 + 优先级）：
1. **F1 + F2**（foundation 审核契约层）—— 修复后 foundation 质量可度量与拦截
2. **F5 + D4 schema/prompt**（story-arc review 维度 + 感情线下沉）—— 修复后 story-arc 质量可度量，感情线有结构化支撑
3. **F7 + D1/D3/D5 自检**（draft 渲染 + 自检钩子）—— 修复后 draft 阶段有质量自觉
4. **F4**（manual 模式 advisory review）—— 改善 web 作者审核体验

---

## Stage 6: Reflection（草稿后前置自检）

### 6.1 审核对象
- **schema**：`reflectionSchema`（`src/novel-v2/prompts/schemas.ts` L577-626）+ `REFLECTION_DIMENSIONS`（L549-558，8 维度）
- **生成提示词**：`buildChapterReflectionPrompt`（`src/novel-v2/prompts/chapter-reflection.ts` L64-158）
- **维度锚点**：`REFLECTION_DIMENSION_ANCHORS`（chapter-reflection.ts L42-51）

### 6.2 schema 审核

**REFLECTION_DIMENSIONS 8 维度**：pace/emotion/suspense/dialogue/density/trope/language/blueprint

对照 quality-standard.md 5 大维度：
- **D1 世界观**：**无专门维度**（不查世界观一致性/主题承载）
- **D2 故事性**：pace + suspense + blueprint 部分覆盖 S1/S4，但 S2 伏笔闭环/S5 多线可收束无维度
- **D3 群像**：dialogue 维度查"声部混淆"但 **E1 配角独立欲望/E3 弧光/E4 关系网络无维度**
- **D4 感情线**：emotion 维度泛化（"是否能引发读者共情"），**非感情线专属**（不查 R1 行动承载/R2 阶段性/R4 女主独立）
- **D5 幽默**：**完全无维度**（trope 查"套路化"但不专门查幽默贴合度）

### 6.3 生成提示词审核

**buildChapterReflectionPrompt L64-158**：
- **优点**：严苛读者+资深编辑双视角；issue 必须引用原文片段；rewriteExample 必填（schema 强制 minLength=1）；severity 判定标准清晰（blocker=弃书/major=跳读/warning=可优化）
- **缺口**：
  - `REFLECTION_DIMENSION_ANCHORS` L42-51 无 D1/D3/D4/D5 维度锚点
  - emotion 锚点"是否能引发读者共情？角色情绪是否平铺直叙、缺乏张力？"是泛化情感，**非 D4 感情线专属**
  - 无世界观一致性自检
  - 无幽默自检

**发现 F8（contract 层，MEDIUM）：reflection 维度不覆盖文学质量 5 维度**
- REFLECTION_DIMENSIONS 8 维度全是"读者体验层面"，无 D1 世界观/D3 群像深度/D4 感情线结构/D5 幽默的专门维度
- reflection 是 draft 后的前置自检，维度缺失意味着这些质量维度在 draft 后仍无自检
- **影响**：D1/D3/D4/D5 缺口从 foundation→story-arc→blueprint→draft 全链传递，reflection 仍不拦截 → 缺陷进入正式 5 reviewer 审核

### 6.4 根因层分类与修复方向

| 缺口 | 根因层 | 修复方向 | 优先级 |
|---|---|---|---|
| F8 reflection 维度不覆盖 5 维度 | contract | `REFLECTION_DIMENSIONS` 扩展 worldbuilding/ensemble/romance/humor 维度，或在现有维度锚点中补充 D1/D3/D4/D5 检查点 | MEDIUM |

### 6.5 Stage 6 审核结论

Reflection 阶段在"读者体验自检"层面有效（pace/emotion/suspense/dialogue/density/trope/language/blueprint 8 维度），但**文学质量维度同样缺失**（F8）。作为 draft 后的前置自检，本应拦截 D1/D3/D4/D5 缺陷，但维度不覆盖让缺陷继续下沉。

---

## Stage 7: Five-Reviewer（5 章节审校者正式审核）

### 7.1 审核对象
- **schema**：`reviewerSchema`（`src/novel-v2/prompts/schemas.ts` L34-81）+ `REVIEW_DIMENSIONS`（L16-25，8 维度）+ `reviewerSchemaForDimensions`（L83-120）
- **reviewer 角色**：`REVIEWER_DIMENSIONS`（`src/novel-v2/prompts/chapter-review.ts` L24-30，5 角色 × 维度映射）
- **审核职责**：`DEFAULT_REVIEW_FOCUS`（chapter-review.ts L39-45）
- **审核提示词**：`buildChapterReviewPrompt`（chapter-review.ts L219-322）
- **commit gate**：`evaluateCommitGate`（`src/novel-v2/temporal/revision-policy.ts` L79-107）

### 7.2 schema 审核（REVIEW_DIMENSIONS L16-25）

**8 维度**：plot / characterVoice / sceneEmbodiment / dialogue / specificity / hookPayoff / continuity / readerRetention

> **F9 修复后更新（2026-07-31）**：REVIEW_DIMENSIONS 已扩展为 12 维度，新增 worldbuilding/ensemble/romance/humor（对照 quality-standard.md D1/D3/D4/D5）。详见下方「F9 修复记录」段。

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
- **发现 F10（policy 层，HIGH）**：修订决策只依赖 REVIEW_DIMENSIONS 评分 → 若 D4/D5 无维度，即使缺失 score 仍可能 ≥4.0 → verdict=passed → commit
- **F10 联动修复**：F9 修复后，toReview 用 REVIEWER_DIMENSIONS[role] 提取分数（含新维度），scoreReviews 聚合含新维度分数，evaluateCommitGate 的 overallScore 基于全 12 维度。reviewer 报告新维度 issue 后 hasBlocker/hasMajor 自动感知 → F10 无需单独修复

---

## F9 修复记录（S3，2026-07-31）

### 修复内容

F9（REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5）是全流程审核瓶颈——无论 foundation/story-arc/blueprint/draft/reflection 阶段有多少质量要求，最终都经 5 reviewer 度量，而原 8 维度完全不覆盖长篇文学质量。修复在 5 处同步修改，形成完整闭环：

1. **schema 层**（`schemas.ts` REVIEW_DIMENSIONS）：8 维度 → 12 维度，新增 worldbuilding/ensemble/romance/humor
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
- **修复后**：12 维度覆盖单章可读性 + 长篇文学质量，5 reviewer 各自负责匹配维度，审核层能度量并驱动迭代
- **覆盖的失败类**：世界观规则冲突 / 配角工具化 / 感情线跳阶 / 幽默破坏声部 这 4 类长篇缺陷，原流程无法拦截，现在可被对应 reviewer 报告为 major，触发修订
- **不覆盖**：生成层（foundation/story-arc/blueprint/draft）的 schema/prompt 缺口（F3/F6/F7）仍需修复，但审核层现在是有效的质量门——即使生成层产出缺陷，审核层能拦截并驱动修订

### 联动修复

- **F10（commit gate 只依赖 REVIEW_DIMENSIONS 评分）**：自动联动修复。toReview 用 REVIEWER_DIMENSIONS[role] 提取分数（含新维度），scoreReviews 聚合含新维度分数，evaluateCommitGate 的 overallScore 基于全 12 维度。
- **F8（reflection 维度不覆盖 5 维度）**：部分联动。REFLECTION_DIMENSIONS 仍是独立 8 维度，未扩展。但 reflection 是 draft 后前置自检，正式审核层（5 reviewer）已覆盖 D1/D3/D4/D5，reflection 的缺口不再致命。F8 完整修复标记为 future work。

### 回归验证

- `npx vitest run src/novel-v2` → 40 files / 282 passed / 38 skipped（0 failed）
- `npx tsc --noEmit` → 无 novel-v2 类型错误
- 修改的测试：prompts.test.ts（makeReviewerOutput scores 12 维度 + style 维度边界断言 + 测试名 "12"）、chapter-review-snapshot.test.ts（responsibilities 12 维度 + dimensionScores 断言 + overallScore 37/12）

### Tradeoffs / Regression Risks

- **reviewer 负载变化**：style 3 维度 / character 3 维度 / continuity 2 / plot 2 / reader 2。character-reviewer 从 2→3 维度，但 ensemble 是人物审核的自然延伸。
- **romance 给 reader-reviewer 而非 character-reviewer**：R1 行动承载/R4 女主独立的技法问题由 character/style 现有维度间接覆盖，reader-reviewer 从追更视角判断阶段感/复杂度。权衡：避免 character-reviewer 4 维度过重。
- **prompt 变长**：4 个 reviewer 的 DEFAULT_REVIEW_FOCUS 各增加一段新维度职责。必要——没有职责定义 reviewer 无法审核新维度。
- **selectReviewerMemory 未修改**：reader-reviewer 的 romance 维度可能需要感情线历史记忆，当前只看 chapter-memory/author-preference/style。标记为 future work（可通过类似 payoffStats 的机制注入感情线阶段记忆）。

---

## 跨 Stage 1-8 根因层汇总

| 根因层 | 发现 | 影响 | 状态 |
|---|---|---|---|
| contract | F1 foundation review 维度错配 | foundation 文学质量无法度量 | 未修复（future work） |
| policy | F2 foundation reviewGate=none 非阻塞 | foundation 缺陷下沉 | 未修复（future work，保留调试逃生口） |
| prompt | F3 foundation 无质量自检 | LLM 无质量自觉 | 未修复（future work） |
| policy | F4 story-arc manual 模式无 advisory review | web 作者无审核参考 | 未修复（future work） |
| contract | F5 story-arc review 维度不足 | story-arc 文学质量部分无法度量 | 未修复（future work） |
| contract | F6 ExecutionBlueprint 无质量字段（by design） | 质量靠上游 schema 传递 | 未修复（future work） |
| prompt | F7 voiceAnchor 未渲染到 draft | D3-E2 声部区分无依据 | 未修复（future work） |
| contract | F8 reflection 维度不覆盖 5 维度 | draft 后自检不拦截文学质量缺陷 | 部分联动（F9 修复后正式审核层覆盖；F8 完整修复 future work） |
| contract | **F9 REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5** | **5 reviewer 无法度量文学质量** | **已修复（S3）** |
| policy | **F10 修订决策只依赖 REVIEW_DIMENSIONS** | **D1/D3/D4/D5 缺陷可带病通过 commit gate** | **联动修复（F9 修复后自动生效）** |

---

## 剩余 stages 与 future work

### 未审核 stages（4/5/9/10/11/12）

F9 修复后，剩余 stages 的审核价值递减——它们都是 F9 的上下游，F9 作为 lowest shared layer 已联动全流程。标记为 future work：

- **Stage 4 preflight/context**：ContextManifest 是否选择质量相关记忆。F9 修复后，即使 preflight 未选择质量记忆，5 reviewer 仍能基于正文 + 冻结上下文审核。future work：preflight 可主动选择感情线/群像/世界观相关记忆注入对应 reviewer。
- **Stage 5 draft**：实际产物审核（D1/D3/D4/D5 退化检测）。F9 修复后，draft 退化会被 5 reviewer 拦截。future work：draft 阶段的生成 prompt 自检（F3/F7）。
- **Stage 9 commit**：commit gate 已在 Stage 8 审核（F10 联动修复）。
- **Stage 10 fact-extraction**：事实提取质量。F9 修复后，缺陷不会通过 commit gate 进入 fact 阶段。future work：fact-extraction 的 D1 世界观规则提取质量。
- **Stage 11 memory**：chapter memory 质量。F9 修复后，缺陷不会通过 commit gate 进入 memory 阶段。future work：memory 的感情线/群像记忆持久化。
- **Stage 12 learning/promote**：经验沉淀闭环。future work：learning.underlyingMechanism 是否覆盖 D1/D3/D4/D5 机制。

### 未修复根因（F1-F8）

F1-F8 均为生成层或 reflection 层缺口，F9 修复后审核层已是有效质量门——即使生成层产出缺陷，审核层能拦截并驱动修订。完整修复标记为 future work，优先级：
1. F1 + F2（foundation 审核契约层）—— 让 foundation 质量可度量与拦截
2. F5 + D4 schema/prompt（story-arc review 维度 + 感情线下沉）
3. F8（reflection 维度扩展）
4. F7 + D1/D3/D5 自检（draft 渲染 + 自检钩子）
5. F4（manual 模式 advisory review）

对照 quality-standard.md 5 大维度：

| 质量维度 | REVIEW_DIMENSIONS 覆盖 | 缺口 |
|---|---|---|
| D1 世界观 | continuity（world/rule 术语）部分覆盖 | **无专门维度**；W1 规则可内化/W2 主题承载/W4 独立质地未评估 |
| D2 故事性 | plot + hookPayoff + readerRetention | S2 伏笔闭环可追溯/S5 多线可收束无专门维度 |
| D3 群像 | characterVoice + dialogue 覆盖单角色 | **E1 配角独立欲望/E3 弧光/E4 关系网络/E5 日常质地无维度** |
| D4 感情线 | **完全无维度** | R1-R5 全缺（REVIEW_ROLE_TERMS L99 含 "romance" 术语但未进 REVIEW_DIMENSIONS） |
| D5 幽默 | **完全无维度** | H1-H4 全缺 |

**发现 F9（contract 层，HIGH）：REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5**
- 与 Loop 1 的 `reviewer-gap-identified` 一致，但此处更精确：8 维度全是"单章可读性"维度，无"长篇文学质量"维度
- **影响**：5 reviewer 即使审核认真，也无法度量 D1 世界观深度/D3 群像独立/D4 感情线结构/D5 幽默贴合 → verdict=passed → 缺陷下沉到 commit

### 7.3 审核职责审核（DEFAULT_REVIEW_FOCUS L39-45）

**优点**：
- 每个 reviewer 职责清晰，含"不要因X判错"的保护
- style-reviewer："环境可以承担氛围、情绪余波、信息或行动功能，只在重复且没有深化体验时报告问题"
- reader-reviewer："章尾驱动力不等于强钩子"

**缺口**：
- **character-reviewer 职责反向阻碍 D3**：L41 "配角可以承担陪伴、见证、阻力或日常质地，不强制每人拥有独立抉择" —— 与 E1（配角独立欲望）冲突。本意是"不强制每章每配角都有独立抉择"，但措辞过强，可能让 reviewer 不报告配角工具化问题
- **无 reviewer 负责 D4 感情线**：character-reviewer 术语含 romance 但职责未提 R1 行动承载/R2 阶段性/R4 女主独立
- **无 reviewer 负责 D5 幽默**：style-reviewer 查语言但不查幽默贴合度
- **无 reviewer 负责 D1 世界观深度**：continuity-reviewer 查规则连续但不查 W2 主题承载/W4 独立质地

### 7.4 审核提示词审核（buildChapterReviewPrompt L219-322）

**优点**：
- 评分锚点 5/4/3/2/1 清晰（L232-238）
- 机械报表识别段（L240-241）
- 长篇耐心段（L243-244）
- 维度边界约束（L248）
- rewriteExample 必填（L257-263）
- reader-reviewer 爽点曲线检查（L280-293）

**缺口**：
- **维度边界约束（L248）反向阻碍 D4/D5**：L248 "你只能把 X 维度的问题写入 issues；其他维度即使有改进空间，也交给对应 reviewer" —— **若 D4 感情线/D5 幽默无对应维度，任何 reviewer 都不会报这些问题**
- 机械报表识别不查"感情报表化"（如"他发现自己爱上了她"）或"幽默硬抖包袱"
- 长篇耐心段保护安静章，但不保护"感情线慢热"或"幽默调节"

### 7.5 根因层分类与修复方向

| 缺口 | 根因层 | 修复方向 | 优先级 |
|---|---|---|---|
| F9 REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5 | contract | 新增 worldbuilding/ensemble/romance/humor 维度，或扩展现有维度锚点覆盖这些质量判据 | HIGH |
| character-reviewer 职责阻碍 D3-E1 | prompt | L41 措辞调整为"配角可以承担陪伴/见证/阻力，但重要配角应有自身欲望，不强制每章每配角都有独立抉择" | MEDIUM |
| 维度边界约束阻碍 D4/D5 报告 | prompt | L248 补充"若发现感情线/幽默/世界观深度问题，即使非你维度，也应在 description 中提示" | MEDIUM |

### 7.6 Stage 7 审核结论

Five-reviewer 阶段是审核层的核心，但 **REVIEW_DIMENSIONS 只覆盖"单章可读性"8 维度，完全不覆盖"长篇文学质量"5 维度**（F9）。这是 Loop 1 已识别的 `reviewer-gap-identified` 的精确化。更严重的是维度边界约束（L248）让 reviewer 即使发现问题也不能报告（因无对应维度）。**F9 是全流程最关键的根因之一**：它使 D1/D3/D4/D5 缺陷可以带病通过 commit gate。

---

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

**发现 F10（policy 层，HIGH）：修订决策只依赖 REVIEW_DIMENSIONS 评分，无质量维度独立门**
- `decideRevision` 基于 `scoreReviews`（综合分）+ `hasBlocker`/`hasMajor`，但 score 来自 REVIEW_DIMENSIONS 的 8 维度
- `evaluateCommitGate` 同样只检查 `REQUIRED_CHAPTER_REVIEWERS` 的 verdict + score
- 若 D4 感情线/D5 幽默无维度（F9），即使感情线/幽默完全缺失，score 仍可能 ≥ 4.0 → verdict=passed → commit
- **影响**：F9（REVIEW_DIMENSIONS 缺口）+ F10（决策只依赖这些维度）= D1/D3/D4/D5 缺陷可带病通过 commit gate → 缺陷进入 fact/memory 永久化

### 8.3 commit gate 审核（evaluateCommitGate L79-107）

**优点**：
- 检查 5 reviewers 全到位（`REQUIRED_CHAPTER_REVIEWERS` L3-9：plot/continuity/style/character/reader）
- 检查 verdict=passed + 无 blocker/major + 综合分 ≥ 4.0 + 单 reviewer ≥ 3.5
- `missingRoles` 报告

**缺口**：
- 同 F10：commit gate 只检查 REVIEW_DIMENSIONS 维度的分数，不检查 D1/D3/D4/D5
- 无"质量维度覆盖检查"——不验证是否评估了世界观/群像/感情线/幽默

### 8.4 根因层分类与修复方向

| 缺口 | 根因层 | 修复方向 | 优先级 |
|---|---|---|---|
| F10 修订决策只依赖 REVIEW_DIMENSIONS | policy | `evaluateCommitGate` 增加质量维度覆盖检查（如要求 worldbuilding/romance 等维度有评分）；或在 F9 修复后联动生效 | HIGH（联动 F9） |

### 8.5 Stage 8 审核结论

Revision 阶段的决策逻辑（改善度阈值/blocker 强制/双分门槛）在工程上健全，但**决策依赖的评分维度不全**（F10）。F9 + F10 形成闭环：REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5 → 评分不反映这些维度 → commit gate 不拦截 → 缺陷永久化。S3 修复 F9 后 F10 自动联动生效，无需独立修复。

---

## 跨 Stage 1-8 根因层汇总（更新）

| 根因层 | 发现 | 影响 | 修复优先级 |
|---|---|---|---|
| contract | F1 foundation review 维度错配 | foundation 文学质量无法度量 | HIGH |
| policy | F2 foundation reviewGate=none 非阻塞 | foundation 缺陷下沉 | HIGH |
| prompt | F3 foundation 无质量自检 | LLM 无质量自觉 | MEDIUM |
| policy | F4 story-arc manual 模式无 advisory review | web 作者无审核参考 | MEDIUM |
| contract | F5 story-arc review 维度不足 | story-arc 文学质量部分无法度量 | HIGH |
| contract | F6 ExecutionBlueprint 无质量字段（by design） | 质量靠上游 schema 传递 | HIGH（联动 Stage 2） |
| prompt | F7 voiceAnchor 未渲染到 draft | D3-E2 声部区分无依据 | MEDIUM |
| contract | F8 reflection 维度不覆盖 5 维度 | draft 后自检不拦截 D1/D3/D4/D5 | MEDIUM |
| contract | **F9 REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5** | **5 reviewer 无法度量文学质量** | **HIGH（最关键）** |
| policy | F10 修订决策只依赖 REVIEW_DIMENSIONS | D1/D3/D4/D5 缺陷可带病通过 commit gate | HIGH（联动 F9） |
| schema | D4 感情线无字段（foundation + story-arc + blueprint 全链） | R1-R5 全缺 | HIGH |
| schema | D1 世界观无下沉字段 | 弧内/章节世界观一致性无保证 | MEDIUM |
| schema | D3 群像无下沉字段 | 配角出场/弧光无规划 | MEDIUM |
| schema | D5 幽默无字段 | 幽默调节无规划位 | LOW |

**S3 修复推荐顺序**（更新，按根因层 + 优先级 + 联动效应）：
1. **F9 + F10**（REVIEW_DIMENSIONS 扩展 + commit gate 联动）—— **lowest shared layer**：修复后 5 reviewer 能度量 D1/D3/D4/D5，commit gate 能拦截 → 全流程质量闭环
2. **F1 + F2**（foundation 审核契约层）—— 修复后 foundation 质量可度量与拦截
3. **F5 + D4 schema/prompt**（story-arc review 维度 + 感情线下沉）—— 修复后 story-arc 质量可度量，感情线有结构化支撑
4. **F8**（reflection 维度扩展）—— 修复后 draft 后自检能拦截 D1/D3/D4/D5
5. **F7 + D1/D3/D5 自检**（draft 渲染 + 自检钩子）—— 修复后 draft 阶段有质量自觉
6. **F4**（manual 模式 advisory review）—— 改善 web 作者审核体验

**关键洞察**：F9 是全流程的"审核瓶颈"——无论 foundation/story-arc/blueprint/draft/reflection 阶段有多少质量要求，最终都经 5 reviewer 度量，而 REVIEW_DIMENSIONS 不覆盖 D1/D3/D4/D5 → 所有文学质量缺陷都会在 commit gate 通过。修复 F9 是 S3 的最高优先级。

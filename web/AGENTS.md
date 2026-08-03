# Project Agent Constraints

## Iterative Improvement And Root-Cause Analysis

- Treat tests, benchmark scores, generated samples, and user-reported cases as evidence of a problem, not as the specification of the fix.
- Do not add rules that only recognize a particular title, genre, character name, paragraph, exact phrase, fixture shape, chapter index, or benchmark sample. Do not tune thresholds solely until one known sample passes.
- Before changing code or prompts, identify the observed symptom, the failing workflow layer, the underlying mechanism, the affected class of inputs, and the boundaries of the proposed behavior. Distinguish root causes from downstream manifestations.
- Fix the problem at the lowest shared layer that owns the faulty behavior. Prefer reusable contracts, algorithms, data modeling, validation, or execution hooks over accumulating case-specific prompt prohibitions and examples.
- Prompt examples are illustrative, not normative. Express the general principle and decision rule first; vary examples across genres, roles, points of view, chapter functions, and prose styles so that one fixture cannot become an implicit product contract.
- A valid improvement must explain why it addresses the broader failure class and what it deliberately does not cover. Record meaningful tradeoffs and regression risks when the solution changes behavior outside the original case.
- Validate the original failing case and at least one materially different counterexample or cross-scenario case. For novel generation changes, inspect the actual generated artifacts and workflow transitions in addition to automated scores; a higher benchmark score alone is not proof of improvement.
- If evidence disproves the proposed mechanism, revisit the root-cause analysis instead of adding another exception. If a narrow exception is genuinely required by the domain, state and test that domain boundary explicitly.
- Keep changes scoped, but do not confuse a small diff with a general solution. The implementation should remain minimal while covering the identified class of failures.

## LLM 输出净化与结构化约束

LLM 回显指令、注入元注释、包裹代码围栏等问题，必须在结构化输出层或通用启发式层解决，不允许堆叠精确短语黑名单或 case-specific 模式列表。

- 禁止用精确短语数组（如 `["严格依据审核证据", "仅输出替换", ...]`）判断 LLM 输出是否含元注释。应基于行的结构特征（长度阈值、标点模式、冒号位置、Markdown 标题语法）判断。
- 净化函数（如 `sanitizeRevisionOutput`）必须是可跨 prompt 版本、genre 和指令措辞复用的通用逻辑。新增净化规则时，说明它覆盖的结构形态类别，而非列举被匹配的特定短语。
- 当 LLM 输出 schema 可约束输出格式时，优先在 schema 层强制结构化输出（如 `response_format: json_schema`），而非在输出后用正则修补。
- 净化函数中的阈值（长度上限、扫描行数等）属魔法值，必须加 TODO 标注可配置意图。

## 质量阈值与守卫约束

质量改善阈值、回退策略和评分守卫必须泛化设计，不允许为通过特定样本而调参，且必须配合局部退化守卫。

- 阈值常量（如 `PARTIAL_IMPROVEMENT_THRESHOLD`）的注释必须描述根因和决策依据，不允许引用特定章节/样本的具体分数变化。
- 当"整体改善但局部退化"的接受逻辑引入阈值时，必须同时设置局部退化上限守卫（如 `MAX_REVIEWER_SCORE_DROP`），防止局部质量退化被整体改善掩盖。
- 守卫约束必须对齐 spec 中定义的回退原则（如"同类最高分"优先），不允许与 spec 的回退规则产生矛盾。
- 新增守卫必须有测试覆盖：验证守卫生效（退化超限被拒绝）和守卫未误杀（退化在限内被接受）两个方向。

## Prompt 示例与维度覆盖

Prompt 中的示例和审核维度必须覆盖 spec 定义的全部质量维度，且示例必须跨题材泛化。

- 审核维度（`REVIEW_DIMENSIONS` / `REFLECTION_DIMENSIONS`）必须覆盖 `quality-standard.md` 定义的 5 大维度（D1 世界观 / D2 故事性 / D3 群像 / D4 感情线 / D5 幽默）。新增维度时同步更新 schema 枚举、维度锚点描述和测试断言。
- Prompt 中的禁止/允许模式示例必须用通用叙事模式描述（如"叙述者直接总结他人心理"而非"少年不甘心地妥协了"），不允许嵌入特定角色名、场景或题材。
- 当 spec 文档（如 `pipeline-audit.md`）记录了维度缺口和修复方向时，代码修复必须对齐 spec 建议的方向（如 F8 建议扩展 D1/D3/D4/D5，不得只扩展其他维度而忽略）。

## Spec 文档同步演进

代码架构变更时，spec 文档必须同步更新，不允许代码与 spec 长期偏离。

- 新增机制（如 thematicTreatment、NarrativeRhythmSnapshot、rebase 扩展、修订防退化机制等）必须在 `workflow-map.md` 或相关 spec 文档中记录其设计意图、数据流和约束。
- spec 中记录的工具数、维度数、阶段数等量化指标必须与代码实际值一致。代码变更后立即同步 spec 中的数字。
- 当 spec 文档间存在矛盾时（如 workflow-map.md 的 Load 步骤描述与 AGENTS.md 的章节审校契约不一致），以代码实际行为为准更新 spec，并在文档中标注矛盾已消除。
- 范围蔓延（scope creep）的处理方式是更新 spec 使其成为正式契约，而非删除代码功能——前提是功能确实有价值且不与现有契约冲突。

## 章节审校工作流复用

已定稿但内容不完美的章节需要"严苛读者视角审视 + 文案内容优化"能力。该能力必须复用正式章节生成的审核+优化闭环，不允许另起一套独立的离线修订逻辑。

- 入口：`chapterReviewWorkflow`（`src/novel-v2/temporal/workflows.ts`），从 `review` 阶段半截启动 Temporal durable execution。
- 复用范围：`review` → `revise` → `manuscriptApproval` → `extractFacts` → `approveFacts` → `commit` → `enrichCharacters` activity（均在 `src/novel-v2/temporal/activities.ts`），禁止重写或绕过这些 activity。
- 产物回填契约：把 `document.plainText` 包装为 draft artifact、复用历史 blueprint artifact 的 `structuredData`（保留 beats/title/startingState 等 `ChapterBlueprint` 不存储的字段），使 review-stage 能拿到 draft+blueprint+contextPacket 三件套。
- 前置条件：`document.status === "final"`（只对已定稿章节开放重审）、无活跃工作流、存在历史 blueprint artifact。
- 不跳过 fact-extraction/commit：让 fact-extraction 用 `novelty` 字段去重，commit-stage 更新 `document.plainText/contentHtml` 并对新 `DocumentRevision` 创建 chapter memory，保持与正式生成一致。
- 不设置 `conversationThreadId/creativeBriefId`：review-stage 在无 threadId 时走 `contextPacketId` 路径，跳过 context/blueprint/blueprint-approval/draft 阶段。

## 经验沉淀与技能/提示词迭代

MCP 工作流的核心是迭代优化。审核经验必须沉淀为可复用经验技巧，并通过 improvement propose/promote 流程迭代相关技能与提示词，不允许只在本次修复中起作用。

- learning 闭环：`externalReview.learning.conclusion === "propose-improvement"` 时必须自动构造 `createCraftRuleCandidate`，不允许仅事件透传而不触发 proposeImprovement。
- review-stage → learning 通路：review/commit 后必须汇总 issue 模式为 `RuntimeLearningAssessment`，不允许审核结果只写入 qualityReport 而不反馈到 learning。
- skill-iteration 的 `buildIterationPrompt` 必须追加 learning 段落（`underlyingMechanism` 而非仅 issue 症状），不允许只把 issue 列表塞给 LLM 让它猜机制。
- `learning.underlyingMechanism/affectedInputClass` 在 `conclusion=propose-improvement` 时必填，不允许只记录症状不记录机制。
- promote 后必须做回归验证（用新版本重跑失败场景），不允许只看 A/B 分数提升就 promote。

## IndexedDB 删除/关闭契约

UI 必须始终提供删除/关闭路径，不允许因全局开关形成逻辑死锁。

- `closeProposal` 在 `legacyReadOnly` 模式下仍须调用 `rejectProposal`（只改本地 IndexedDB status，不触发 formal mutation），不允许被 `legacyReadOnly` 短路。
- `legacyReadOnly` 只能禁用采纳/重生成/AI审核等 formal mutation 路径，不能禁用本地状态清理。
- `removeProject` 在 runtime 不可达时必须仍能删除本地 IndexedDB 项目，不允许因 `ensureRuntimeProject` 抛错阻塞本地清理。
- runtime 删除是尽力而为：try/catch 失败时只警告用户"运行时仍有该项目记录，重启后可能恢复"，不阻塞 `deleteLocalProject`。

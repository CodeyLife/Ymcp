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

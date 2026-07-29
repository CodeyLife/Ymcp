# Novel MCP V2

The MCP server in `scripts/novel-v2-mcp-server.mjs` calls `executeTool` from `src/novel-v2/mcp/index.ts` directly (no HTTP proxy). It loads 23 tools defined in `src/novel-v2/mcp/tool-definitions.ts`. Start with `pnpm novel:mcp:v2` (requires Postgres + tsx loader).

## Tools

- `novel_run_create` / `novel_run_get` / `novel_run_complete` manage CreativeRun lifecycle.
- `novel_action_list` / `novel_action_execute` list and execute commands on work items.
- `novel_artifact_get` / `novel_review_submit` inspect artifacts and submit reviews.
- `novel_catalog_get` / `novel_receipt_get` / `novel_rule_target_get` read catalogs, receipts, rule targets.
- `novel_rule_candidate_create` / `novel_rule_candidate_get` / `novel_rule_evidence_submit` / `novel_rule_foundation_evaluate` / `novel_rule_review_submit` / `novel_rule_promote` / `novel_rule_rollback` manage craft-rule candidate evolution.
- `novel_project_create` / `novel_project_list` / `novel_project_delete` manage project lifecycle.
- `novel_bootstrap_run` / `novel_chapter_review` one-click flows.
- `novel_closed_loop_run` evaluation closed-loop.

## novel_project_create — 一句话创意创建小说项目入口

对齐 v1 `bootstrapNovelFromCoreIdea` 的"一句话创意"入口,与 HTTP `POST /v2/projects` 同构。

**入参:**

- `premise` (string,必填):一句话创意/故事梗概,作为创作核心。会被写入 `project.metadata.premise`,并作为 bootstrap `objective` 让每个 foundation task 都知道创意核心。
- `idempotencyKey` (string,必填):幂等键。同时作为 `projectId`(与 v1 行为一致),重复调用同 key 不会重复创建项目或启动 bootstrap。
- `title` (string,可选):项目标题。未提供则从 `premise` 自动派生(取第一句前 24 字,见 `provisionalTitle`)。`project-positioning` task 会润色生成正式书名,此字段只提供初始标题。
- `genre` (string,可选):题材标签(如 玄幻/都市/言情/科幻/悬疑),用于 `resolveSkillBundle` 匹配 `applicableGenres`。
- `autoBootstrap` (boolean,默认 `true`):是否自动启动全书规划。`true` 时调用 `startNovelBootstrap` 创建 CreativeRun + enqueue 10 个 foundation task(+ 可选 chapter-plan)并启动 Temporal `creativeRunWorkflow`。
- `includeChapterPlan` (boolean,默认 `true`):bootstrap 是否包含章节计划任务。仅 `autoBootstrap=true` 时生效。`chapter-plan` 是 `REQUIRED_FOUNDATION_TASK_KEYS` 必填项,设为 `false` 后续 `novel_chapter_generate` 会被前置检查拒绝。
- `objective` (string,可选):bootstrap 目标。未提供则用 `premise` 作为 objective。

**返回:**

- `autoBootstrap=true`:`{ project, bootstrapRun }`,`bootstrapRun` 含 `run/workItems/taskChain/workflowId/temporalRunId/reused`。
- `autoBootstrap=false`:`{ project }`,仅创建项目不启动规划。

**与 novel_bootstrap_run 的关系:**

- `novel_project_create(autoBootstrap=true)` 用于**新项目**:一站式创建项目+启动全书规划。
- `novel_bootstrap_run` 用于**已存在项目**:重新/补充启动规划(如旧项目未做 foundation,或想重做规划)。
- 两工具底层都调用 `startNovelBootstrap`,任务链 DAG 完全相同。

## Operating contract

- MCP clients submit intents or task signals; they do not mutate formal manuscript data directly.
- Formal commits must pass through `CommitService` and require current internal plus independent review evidence bound to the artifact fingerprint.
- Memory retrieval is resolved before the execution blueprint is compiled; agents should inspect `memory_bundle` and `execution_blueprint` records when debugging context quality.
- Local credentials belong in ignored env files or process environment, never in tracked docs, MCP payload logs, or memory files.

# Novel V2 小说创作工作流

> 梳理基线：2026-07-31 当前工作树，`HEAD=79986a9`。本文描述正在使用的 Novel V2 Runtime；工作树继续演进后，应按文末维护清单同步更新。

本文面向后续架构、提示词、创作质量与可观测性迭代，回答四个问题：创作请求从哪里进入、由谁持久编排、每个阶段消费和产出什么、失败或人工决策后如何继续。

相关资料：

- [Novel V2 Runtime](../novel-v2-runtime.md)：部署拓扑、环境变量和 HTTP 边界。
- [Novel MCP V2](../novel-mcp.md)：MCP 工具与调用契约。
- [流程质量审核报告](./pipeline-audit.md)：各阶段提示词、Schema 和产物质量审核；本文不重复其中的质量结论。
- [质量标准](./quality-standard.md)：创作产物与审校的评价基准。
- [研究方法矩阵](./research-methods.md)：公开资料、创作机制与 Runtime 契约的对应关系。

## 0.1 当前质量闭环基线（2026-08-02）

- 创建入口仍接受 `premise` 单字段；可选 `creativeBrief` 会以版本化对象写入 `project.metadata`，HTTP、MCP、Web 统一走同一解析器。
- Foundation 仍是 10 个任务，不增加阶段数量；每个任务先经过语义结构契约，再生成专属 `foundationReview`，审核结果绑定当前 artifact fingerprint。
- 默认 `reviewGate=manual`。`project-positioning`、`architecture`、`characters`、`worldview`、`plot-design` 必须同时满足专属审核与作者确认；其余五项可按审核策略自动接受，但出现重大问题或上游变化时转人工。
- `reviewGate=none` 仅供测试和显式调试，不属于正常创建默认值。
- Story Arc 的章节蓝图现在必须携带 `worldRuleRefs`、`characterFocus`、`romanceTreatment`、`humorTreatment`；感情线、幽默和配角戏份允许明确 `not-applicable`，不强制每章填充。
- 章节正文仍复用 `review → revise → manuscriptApproval → extractFacts → approveFacts → commit → enrichCharacters`，旧 artifact 的审核证据不能满足新 fingerprint 的门禁。

## 1. 范围与阅读约定

- **当前主线**：PostgreSQL 是结构化真源，Temporal 持有长流程，正文与大对象通过对象存储保存，Qdrant 只承担可重建的语义索引。
- **客户端边界**：Web、HTTP、MCP、CLI 都是可替换客户端；正式正文不能由客户端绕过 Runtime 直接写入。
- **V1 边界**：旧 `/v1/projects`、`novelRuntimeClient`、SQLite Runtime 和旧 NovelStudio 不属于当前兼容目标。
- **图中实线**表示当前生产路径，**虚线**表示可选路径、人工路径、失败回退或兼容分支。
- `CreativeRun` 负责 Foundation 与通用 work item 编排；正式章节生成仍由 `novelIntentWorkflow` 和共享章节生命周期负责，不存在第二套章节生成实现。

## 2. 系统总览

```mermaid
flowchart LR
  subgraph Clients["可替换客户端"]
    Web["Web / NovelV2Studio"]
    Http["HTTP API 客户端"]
    Mcp["MCP Agent"]
    Cli["CLI"]
  end

  subgraph Adapters["入口与应用服务"]
    Api["scripts/novel-v2-api.ts"]
    McpGateway["MCP executeTool / handlers"]
    AppServices["application/* 启动器与共享服务"]
  end

  subgraph Durable["持久编排"]
    Temporal["Temporal Server"]
    Worker["novel-v2 Worker"]
    Workflows["workflows.ts"]
    Activities["activities.ts"]
  end

  subgraph Runtime["运行时能力"]
    Lifecycle["runChapterLifecycle"]
    ModelGateway["ModelGateway / purpose routing"]
    ExternalTasks["model_tasks / external MCP"]
    Commit["CommitService"]
    Learning["Learning / CraftRule / Evaluation"]
  end

  subgraph Stores["持久化与检索"]
    Pg[("PostgreSQL\n结构化真源")]
    Objects[("S3 / MinIO / file\n不可变内容对象")]
    Qdrant[("Qdrant\n可重建语义索引")]
  end

  Web --> Api
  Http --> Api
  Cli --> Api
  Mcp --> McpGateway
  Api --> AppServices
  McpGateway --> AppServices
  AppServices --> Temporal
  Temporal --> Worker --> Workflows --> Activities
  Activities --> Lifecycle
  Activities --> ModelGateway
  ModelGateway -. "无内部候选可执行" .-> ExternalTasks
  ExternalTasks -. "artifact / fail signal" .-> Workflows
  Activities --> Commit
  Activities --> Learning
  Activities --> Pg
  Activities --> Objects
  Activities --> Qdrant
  Commit --> Pg
  Commit --> Objects
  Commit --> Qdrant
  Learning --> Pg
```

### 2.1 入口矩阵

| 用户意图 | Web / HTTP 入口 | MCP 入口 | 应用服务 / Temporal workflow | 主要结果 |
| --- | --- | --- | --- | --- |
| 一句话创建小说 | `POST /v2/projects` | `novel_project_create` | `startNovelBootstrap` → `creativeRunWorkflow` | 项目、10 阶段宏观规划 run |
| 已有项目启动规划 | `POST /v2/projects/:id/bootstrap` | `novel_bootstrap_run` | `startNovelBootstrap` → `creativeRunWorkflow` | Foundation work items 与规划 section |
| 生成/扩展故事弧 | `POST /v2/projects/:id/story-arcs/next`、`.../batches/next` | `novel_story_arc_start` | `startStoryArcPlanning` → `storyArcPlanningWorkflow` | 故事弧、滚动批次、章节蓝图与规划上下文 |
| 生成章节 | `POST /v2/intents` | `novel_chapter_generate` | `novelIntentWorkflow` | 定稿正文、事实、修订、章节记忆 |
| 重审已定稿章节 | `POST /v2/projects/:id/documents/:documentId/review` | `novel_chapter_review` | `chapterReviewWorkflow` | 新修订或保留原稿、更新事实与记忆 |
| 查询运行 | `GET /v2/runs/:workflowId` | `novel_workflow_get/list` | 读取 `workflow_runs`，必要时查询 Temporal | 当前状态、阶段、产物与诊断 |
| 运行改进闭环 | `POST /v2/projects/:id/closed-loop` | `novel_closed_loop_run` | `runClosedLoop` | 实验、候选、回归、推广或回滚 |

MCP server 直接调用 `executeTool`，不是 HTTP 代理；HTTP 与 MCP 最终必须汇入相同的应用服务、Temporal workflow 和正式提交边界。

## 3. 作者主流程

```mermaid
flowchart TD
  Idea["一句话创意 premise"] --> Brief["可选创作简报\n读者/主题/人物/研究/结局边界"]
  Brief --> Create["创建 Project\n写入 metadata.premise + creativeBrief"]
  Create --> Bootstrap["startNovelBootstrap"]
  Bootstrap --> Foundation["10 阶段 Foundation DAG"]
  Foundation --> PlanReview["作者检查、编辑、确认规划 section"]
  PlanReview --> Required{"architecture / characters /\nworldview / plot-design 已批准?"}
  Required -- "否" --> PlanReview
  Required -- "是" --> Arc["生成当前故事弧"]
  Arc --> ArcReview{"故事弧审核策略"}
  ArcReview -- "Web/manual" --> AuthorArc["作者审批 / 编辑 / rebase / abandon"]
  ArcReview -- "MCP/auto" --> AutoArc["自动审校与有限修订"]
  AuthorArc --> Rolling["按批次滚动生成章节蓝图"]
  AutoArc --> Rolling
  Rolling --> ChapterTarget["创建或取得章节 Document"]
  ChapterTarget --> Generate["novelIntentWorkflow"]
  Generate --> Quality["五角色审校 + 自动修订 + 提交门禁"]
  Quality -. "需要作者决策" .-> HumanGate["批准 / 修订 / 拒绝 / 放弃"]
  HumanGate --> Quality
  Quality --> Final["Document final + DocumentRevision"]
  Final --> Memory["事实、叙事状态、章节记忆、角色关系更新"]
  Memory --> Next{"本故事弧还有章节?"}
  Next -- "是" --> ChapterTarget
  Next -- "否" --> MoreArc{"继续下一故事弧?"}
  MoreArc -- "是" --> Arc
  MoreArc -- "否" --> Done["全书阶段完成"]
```

`chapter-plan` 入参仅为旧客户端兼容，当前 bootstrap 固定不生成静态全书章节表。章节方案由故事弧按批次滚动生成，避免在创作早期冻结整部长篇。

## 4. Foundation 全书规划

### 4.1 任务依赖图

```mermaid
flowchart TD
  P["project-positioning\n项目定位"]
  A["architecture\n全书架构"]
  C["characters\n主要人物"]
  W["worldview\n世界观"]
  R["relations\n人物关系"]
  T["plot-threads\n剧情线"]
  F["foreshadowing\n伏笔规划"]
  L["timeline\n时间线"]
  S["story-control\n叙事控制"]
  D["plot-design\n长程叙事战略"]

  P --> A
  P --> C
  P --> W
  C --> R
  W --> R
  A --> T
  C --> T
  W --> T
  T --> F
  T --> L
  W --> L
  A --> S
  T --> S
  R --> D
  F --> D
  L --> D
  S --> D
```

### 4.2 单个规划阶段生命周期

```mermaid
flowchart LR
  Locked["locked"] --> Ready["ready"] --> Generating["generating"]
  Generating --> Artifact["foundation artifact"]
  Artifact --> Await["awaiting-confirmation"]
  Await --> Approved["approved"]
  Await -. "作者要求重生成" .-> Generating
  Await -. "作者编辑" .-> Edited["新 artifact / editRevision + 1"]
  Edited --> Await
  Approved -. "上游内容被替换" .-> Stale["stale"]
  Stale --> Generating
  Generating -. "生成失败" .-> Failed["failed"]
  Failed --> Generating
```

关键逻辑：

1. `startNovelBootstrap` 创建一个 `CreativeRun`，按 DAG 建立 `CreativeWorkItem.dependsOn`，并初始化 `project_plan_sections`。
2. `creativeRunWorkflow` 自动或按用户信号选择可执行 work item；同一层可并行，依赖未满足的阶段保持锁定。
3. `generateFoundationWork` 使用 `planning.foundation` 模型目的生成结构化 artifact；无内部模型时创建外部任务等待回填。
4. 默认 `reviewGate=manual`。Foundation 生成后先执行专属审核；核心五项还必须等待作者确认，非核心阶段可由独立审核结果按策略自动接受。
5. 每条审核证据绑定当前 artifact 的 `subjectArtifactId`；Foundation review artifact 还记录当前 `artifactFingerprint`，过期证据不能放行新版本。
6. 编辑或重生成上游 section 时，`transitivePlanDependents` 界定需要重新检查的下游范围，并将相关 section 与故事弧标记为 stale。
7. 正文创作的最低前置门禁是 `project-positioning`、`architecture`、`characters`、`worldview`、`plot-design` 全部为 `approved`；其他规划仍会作为可用 Foundation 上下文参与创作。
8. Foundation artifact 在记忆检索前被投影为 Foundation memory claims；PostgreSQL 写入成功但 Qdrant 更新失败时，索引可后续重建。

### 4.3 Foundation 结构与审核契约

`foundationSchema` 保证通用 JSON 外形，`foundation-contract.ts` 再按 taskKey 检查语义必填路径和重复条目字段。十个任务的结构化落点分别覆盖定位承诺、卷级架构、人物欲望与弧光、世界规则与代价、方向性关系、主支线因果、伏笔回收、故事时间、节奏分布、长期终局边界。

`foundation-review.ts` 使用独立的五维架构审核契约：D1 世界观、D2 故事性、D3 群像、D4 感情线、D5 幽默。每个 issue 都要带 evidence path、严重级别和修复建议；一致性检查失败时，即使模型给出 `passed` 也会被规范化为 `revise`。核心阶段的作者确认通过既有 `project_plan_sections` 和审计记录完成，不另建 Foundation 数据表。

## 5. 滚动故事弧与章节蓝图

```mermaid
flowchart TD
  Start{"首次故事弧还是下一批次?"}
  Start -- "首次 / rebase" --> CreateArc["createNextStoryArc 或 markStoryArcGenerating"]
  Start -- "下一批次" --> PrepareBatch["prepareNextStoryArcBatch"]
  CreateArc --> Generate["generateStoryArcBundle"]
  PrepareBatch --> Generate
  Generate --> Project["projectStoryArcBundle\n投影 arc、batch、chapter blueprints"]
  Project --> Review["reviewStoryArcBundle"]
  Review --> Learning["blocker/major → story-arc learning"]
  Learning --> Policy{"reviewPolicy"}
  Policy -- "manual" --> Wait["manual-review-required"]
  Wait --> Human{"作者操作"}
  Human -- "approve" --> Approved["approveStoryArc"]
  Human -- "edit" --> Edited["编辑后重新投影"]
  Edited --> Wait
  Human -- "rebase" --> CreateArc
  Human -- "abandon" --> Abandoned["abandoned"]
  Policy -- "auto" --> AutoGate{"passed 且无 blocker/major?"}
  AutoGate -- "是" --> Approved
  AutoGate -- "否，仍可修订" --> Revise["reviseStoryArcBundle"]
  Revise --> Project
  AutoGate -- "blocked 或达到上限" --> ManualFallback["failStoryArc / manual-review-required"]
  Generate -. "异常" .-> Failed["failed；批次记录失败原因"]
```

- Web 默认 `manual`，MCP 默认 `auto`；调用方可以显式选择策略。
- 自动策略最多修订两次。通过后才自动批准；被阻塞或达到上限时保留产物并转人工处理。
- 故事弧 bundle 同时携带批次位置与章节蓝图。外部修订结果不得改写当前 `batchIndex` 或 `startChapterIndex`。
- `ChapterPlanningContext` 将故事弧的起始状态、长线约束和章节位置冻结到具体 blueprint，供后续 draft/review/revision 使用。
- 每章蓝图新增 `narrativeScale`：`compact/standard/extended` 表示主导功能需要被读者经历的展开深度，另含 `reason`、`developmentAxes` 和 `stoppingCondition`。`standard` 是普通网文完整章节的软性体量参考（通常约 3000 字上下），不是字数下限；正文可以在同一事件内部通过感知、试错、选择、代价和余波达到规模，不得用第二套主线或灌水填充。
- 每章蓝图的四个质量字段会被渲染到 `ChapterPlanningContext`：世界规则引用必须对应已批准规则；`characterFocus` 写配角自身欲望、行动和代价；感情线与幽默用 `not-applicable/background/active` 表达适用性和证据，不因安静章缺少二者而误杀。
- Story Arc 审核还检查 `thematicTreatment` 的处理方式，要求主题通过选择、关系、后果或世界反应呈现，避免直接解释主题结论。
- rebase（重基线）不是简单的重新生成：审核阶段对 rebase 目标执行**对抗式双轮审核**——首轮以 `balanced` 视角按多维锚点与整弧校验评分，次轮以 `adversarial-authority` 视角从每章 `unresolvedAtClose` 倒推检查所有指定路径，把候选断言当作待证明命题，只要冻结证据不能蕴含就列入 `certaintyUpgrades`。两轮结果经 `mergeStoryArcReviews` 合并后统一校验。
- 重基线目标按文档是否已有 `revisionId` 分层：已定稿章节以 `committedMemory`、当前修订事实和 author-scope claims 为最高权威；尚未创作章节不是缺失的历史事实，而是沿用最近一次 `story-arc.approved` 产物中的 `plannedBlueprint`，只允许补充缺失的 `narrativeScale` 等执行信号，禁止模型凭空重写未来事件或状态。若未来章节没有可恢复的已批准蓝图，重基线必须阻断并要求先完成正式规划。
- `authorityChecks`（事实权威检查）为每章输出一条，逐项覆盖运行时指定的候选路径（`checkedPaths`），摘录候选断言（`candidateClaims`）与冻结依据（`frozenEvidence`），判定采用蕴含而非相容：存在一个满足全部冻结事实但候选断言仍可能为假的世界时，该断言写入 `certaintyUpgrades`。观察变原因、可能危险变求助/救援、决定行动变已经行动、身份或来意未知变幕后关系等均属于确定性升级。
- `certaintyUpgrades`（确定性升级）非空时强制该章 `verdict=revise` 并在 issues 中生成对应 major；即使六维检查全部通过也不能覆盖事实权威失败。这防止 rebase 借"合理剧情"之名覆盖已发生的故事事实。
- `chapterChecks` 必须覆盖 `longform-function`：逐章只判断章节功能是否在长篇当前位置成立，不要求每章都有新信息、新压力、新爽点或主线推进；余波、等待、恢复、日常、气氛、误判和关系沉淀都可以是合法章节功能。
- 故事弧审核还要检查 `narrativeScale` 与章节功能是否一致：`standard/extended` 若只完成首个状态变化便收束，应报告 `chapter.premature-closure` 的具体证据；该检查依据 `developmentAxes` 和 `stoppingCondition`，不依据字符数。旧蓝图缺少该字段时由运行时归一化为 `standard` 软信号，不把缺失字段当作短章许可，也不产生字数门槛。
- `arcChecks` 必须覆盖 `function-rhythm`、`theme-distribution`、`motif-evolution`、`motif-integration`、`longform-hierarchy`、`window-variation` 与 `pressure-trajectory`。其中 `longform-hierarchy` 检查全书/卷级战略、故事弧、批次与章节的职责分层，防止局部蓝图吞掉上层规划；`window-variation` 检查连续章节窗口是否允许重复但产生新的理解、关系、社会质地、信息角度、情绪重量或行动代价；`motif-integration` 检查核心设定/职业/金手指/主题隐喻是否已转写为具体事件、感官压力、人物选择和递进意象；连续标题、场景名或转折描述只贴同一概念标签时，必须进入修订。`pressure-trajectory` 只在弧/批次窗口层判断张力形态变化，不要求每章都新增或加剧压力。

### 5.1 故事弧删除与 force 级联

`deleteStoryArc` 支持两种模式：

- **默认模式（无 force）**：若故事弧下任一章节已关联正文（`current_revision_id` 存在、`revision_count > 0` 或 `document_status !== "planned"`），拒绝删除并提示作者改用"放弃故事弧"保留历史记录。这防止误删已进入创作流程的章节。
- **force 级联删除**：传 `force=true` 时，在同一事务内级联清理：取消关联的 `workflow_runs`（标记为 `cancelled`）、删除 `manuscript_revisions`、`chapter_memories`、`memory_claims`（含来源指向被删文档/修订的记录）以及关联的伏笔记录。force 删除是破坏性操作，用于彻底清除一个故事弧及其全部下游产物；非 force 路径保留可审计历史，应作为常规选择。

## 6. 正式章节生成

### 6.1 `novelIntentWorkflow` 详细流程

```mermaid
flowchart TD
  Intent["NovelIntent\nweb / api / mcp / cli"] --> Snapshot["loadProjectSnapshot"]
  Snapshot --> Preflight["createPreflight"]
  Preflight --> Retrieve["retrieveMemory\n权威叙事状态 + 检索结果"]
  Retrieve --> Skills["resolveSkills"]
  Skills --> Foundation["listFoundationArtifacts"]
  Foundation --> PlanGate["assertRequiredPlanApproved"]
  PlanGate --> PlanningContext["loadChapterPlanningContext"]
  PlanningContext --> Blueprint["compileBlueprint + ContextManifest\n持久化 cognition"]
  Blueprint --> MemoryGate{"关键 fact / chapter-memory\n连续缺失达到阻断条件?"}
  MemoryGate -- "是" --> Blocked["failed\n先重建记忆索引"]
  MemoryGate -- "否" --> Draft["draftByRefs\n生成 draft artifact"]
  Draft --> Reviewers["五角色并行审校"]
  Reviewers --> Decision["decideRevision\n评分、严重度、改善度"]
  Decision -- "继续修订，最多 2 轮" --> Revise["reviseByRefs\n生成 revision artifact"]
  Revise --> Reviewers
  Decision -- "停止修订" --> Best["选择无 blocker 优先、同类最高分的最佳稿"]
  Best --> Learning["assessLearning\n终态候选汇总 issues"]
  Learning --> CommitGate{"evaluateCommitGate"}
  CommitGate -- "不通过 / memory manual-review" --> ManuscriptGate["manual-review-required\n作者批准、修订、拒绝或放弃"]
  ManuscriptGate -- "修订" --> Revise
  ManuscriptGate -- "拒绝" --> Rejected["rejected"]
  ManuscriptGate -- "放弃" --> Abandoned["abandoned"]
  ManuscriptGate -- "批准，可替换 artifact" --> Facts["extractFacts"]
  CommitGate -- "通过" --> Facts
  Facts --> FactPolicy{"factApprovalMode=manual\n且存在 pending facts?"}
  FactPolicy -- "是" --> FactGate["manual-review-required\n逐项 approve / reject"]
  FactGate -- "确认继续" --> ApproveFacts["approveFactClaims"]
  FactGate -- "放弃" --> Abandoned
  FactPolicy -- "否" --> AutoFacts["approveFacts"]
  ApproveFacts --> Commit["CommitService.commit"]
  AutoFacts --> Commit
  Commit --> Revision["更新 Document + 新 DocumentRevision\n创建 chapter memory"]
  Revision --> Enrich["enrichCharacters\n角色知识、动机与关系增量"]
  Enrich --> Complete["completed"]
  Enrich -. "失败不回滚已提交正文" .-> CompleteWithWarning["completed + enrichmentError"]
```

### 6.2 上下文冻结与传递

1. `PreflightPlan` 根据目标章节、叙事截止点、POV 和任务类别声明检索 facet。
2. `retrieveMemory` 先修复 Foundation claims，再组合 PostgreSQL 权威叙事状态、开放伏笔/承诺、词法/语义检索结果；token budget 会随任务类别和章节规模调整。此外，`retrieveMemory` 还会加载 `NarrativeRhythmSnapshot`（连续章节叙事节奏快照），该快照由前序已提交章节记忆和已批准蓝图推导而来，包含前序章节的状态摘要、关键事件、情绪弧线、主导叙事功能、主题显隐模式、开放 issue 族，以及禁止提前消费的约束（如未兑现伏笔、未解悬念不得在当前章节越权兑现），使 draft/review 能感知连续叙事节奏而非仅依赖离散事实检索。
3. `SkillBundle` 在 blueprint 编译前解析，记录实际 skill 版本、能力、冲突和缺失项。
4. `compileBlueprint` 同时持久化 `PreflightPlan`、`MemoryBundle`、`SkillBundle`、`ExecutionBlueprint`、`ContextManifest` 与路由快照相关引用。
5. 新工作流优先用 `draftByRefs/reviewByRefs/reviseByRefs` 传递 ID；activity 在执行边界加载不可变快照，减少 Temporal history 载荷并保持同轮上下文一致。
6. Prompt 由 `compileStageContext` 生成 `StagePromptPackage`，诊断记录保存 purpose、manifest/fingerprint、模型路由和对象快照引用。

### 6.3 五角色审校与质量门禁

| 角色 | identity | 主要职责 |
| --- | --- | --- |
| `plot-reviewer` | `internal` | 章节目标、情节因果、节奏、长线承诺与推进 |
| `continuity-reviewer` | `internal` | 事实、时间、位置、人物知识、POV、世界规则连续性 |
| `style-reviewer` | `independent` | 场景呈现、语言具体性、文风与幽默 |
| `character-reviewer` | `independent` | 人物声部、动机、选择和关系发展 |
| `reader-reviewer` | `independent` | 追更体验、章节功能、卖点兑现、爽点与感情线 |

当前决策常量：

| 常量 | 当前值 | 作用 |
| --- | --- | --- |
| `DEFAULT_MAX_AUTO_REVISIONS` | `2` | 自动修订最大轮数 |
| `MIN_IMPROVEMENT_THRESHOLD` | `0.15` | 连续修订改善不足时停止循环 |
| `MIN_AUTOMATIC_COMMIT_SCORE` | `4.0 / 5` | 自动提交综合分门槛 |
| `MIN_REVIEWER_SCORE` | `3.5 / 5` | 任一必需 reviewer 的最低分 |

自动提交还要求五个必需 reviewer 都绑定当前 artifact fingerprint、全部 `passed`，不存在 blocker/major，并覆盖冻结章节蓝图声明的适用质量维度：`plot`/`hookPayoff` 为基础维度，世界规则、群像焦点、感情线或幽默标记为适用时还必须有对应 `dimensionScores` 或 issue evidence。`not-applicable` 不会加入硬门槛。`CommitService` 复用同一集合做最终复核。若修订降低质量，系统按“无 blocker 优先，其次同类分数更高”回退到本轮最佳稿。

`blueprint-approval` 和 `deterministic-check` 仍存在于共享阶段类型/展示元数据中，但当前 `novelIntentWorkflow` 没有独立的人工作流等待点：上游规划/故事弧审批提供 blueprint 的作者控制，writer self-check 已并入当前生成提示词与正式 reviewer 闭环。

### 6.4 主题显隐系统（thematicTreatment）

章节蓝图（`ChapterBlueprint`）携带 `thematicTreatment` 字段，控制主题在正文中的显隐模式，是贯穿 story-arc → draft → review → revision 全链路的权限与边界约束，而非逐章主题任务。

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `mode` | `absent` / `subtext` / `foreground` | `absent`：本章不承担主题推进；`subtext`：只让读者从行动、关系或后果自行推断，不得由作者或人物直接点明；`foreground`：允许人物围绕具体处境争执价值，但仍不得宣布标准答案 |
| `carrier` | `none` / `choice` / `consequence` / `relationship` / `world-reaction` / `dialogue-conflict` | 主题承载方式，约束主题通过哪类叙事载体显现 |
| `questionRefs` | `string[]` | 引用故事弧 `thematicQuestions` 中的问题 ID；不得为了填满引用而让每章都碰主题 |
| `evidenceChange` | `string` | 本章只改变的主题证据，限定主题推进的具体落点 |
| `expositionBoundary` | `string` | 解释边界，禁止作者或角色直接总结主题结论 |

故事弧同时声明 `thematicQuestions`（`ThematicQuestion`：含 `question`、`opposingPressures`、`resolutionWindow`），为章节 `questionRefs` 提供可引用的稳定主题问题源。

全链路一致性：

1. **story-arc 阶段**：蓝图规划时为每章设定 `mode`/`carrier`/`questionRefs`，确立主题显隐模式与边界。
2. **draft 阶段**：正文生成时按 `mode` 约束主题表达——`absent` 不碰主题，`subtext` 只产生潜台词，`foreground` 才允许正面争执但不给结论。
3. **review 阶段**：审核者检查正文是否越权（如 `subtext` 章节出现人物直接宣布主题结论）。
4. **revision 阶段**：修订时保持主题显隐一致，不得在修复其他问题时引入与 `mode` 冲突的主题表达。

`NarrativeRhythmEntry` 也会携带 `thematicMode` 与 `themeCarrier`，使连续章节的节奏快照能反映主题显隐的分布与衔接，避免主题在错误窗口被过度复述。

### 6.5 修订防退化与输出净化机制

修订阶段在 `decideRevision` 决策与 `reviseByRefs` 执行之间引入多重防退化与净化机制，确保修订在改善目标 issue 时不引入新的事实漂移、指令回显或策略重复。

| 机制 | 作用 | 实现要点 |
| --- | --- | --- |
| `RevisionAttempt` | 记录前序修订尝试，避免重复策略 | 每轮修订持久化 `iteration`、`outcome`（`accepted`/`reverted-degradation`/`reverted-no-improvement`）、`targetedIssueTitles`、`baselineScore`、`revisedScore`、`approachSummary`；后续修订 prompt 注入历史尝试，促使 LLM 尝试不同策略而非重复同一方向 |
| `sanitizeRevisionOutput` | 清理 LLM 输出中的指令回显与元注释 | 基于结构化启发式（`isLikelyMetaAnnotation`）而非精确短语匹配：剥离 Markdown 代码围栏，逐行扫描开头若干行判断是否为元注释（Markdown 标题、冒号结尾短行、冒号分隔的指令前缀、极短确认行），遇到第一个正文行停止；不依赖固定指令文本，因此可跨 prompt 版本、genre 和指令措辞复用 |
| `detectNamedEntityDrift` | 检测修订前后专有名词漂移 | 提取源文本与修订文本中引号包裹的专有名词（中文引号「」『』""''），比较集合差异：`disappeared`（源有修无，可能被错误替换）、`appeared`（修有源无，可能为幻觉引入）；结果为一次检测信号，由调用方结合审核问题判断是否为预期变更，不自动拒绝修订 |

`revision-policy` 中的最佳稿选择守卫：

| 守卫 | 当前值 | 作用 |
| --- | --- | --- |
| `PARTIAL_IMPROVEMENT_THRESHOLD` | `0.2` | 当修订稿综合分数比基线高出此值、最低 reviewer 分数仍达标、且无新 blocker/major 时，即使某维度分数略降也接受修订；防止严格字典序比较丢弃有效的部分改善 |
| `MAX_REVIEWER_SCORE_DROP` | `0.5` | 单个 reviewer 分数最大允许下降幅度；与 `PARTIAL_IMPROVEMENT_THRESHOLD` 配合，防止局部质量退化被整体改善掩盖 |

这两个守卫共同实现 `isCandidateQualityBetter` 的"无 blocker 优先，其次同类分数更高"回退原则，同时允许"整体改善但某维度略降"的有效修订被接受。

## 7. 已定稿章节重审与定向修复

```mermaid
flowchart TD
  Request["chapterReviewWorkflow 请求"] --> Preflight{"前置条件"}
  Preflight -- "非 final / 有活跃 workflow / 无历史 blueprint" --> Reject["拒绝启动"]
  Preflight -- "满足" --> Load["并行加载\n历史 blueprint + 当前正文 + routing\nMemoryBundle + PlanningContext 快照"]
  Load --> Mode{"mode"}
  Mode -- "full" --> Source{"是否携带 proposedText?"}
  Source -- "是" --> Proposal["作者正文包装为 revision artifact"]
  Source -- "否" --> Current["当前 document.plainText"]
  Proposal --> ReviewDraft["createReviewDraft\n保留 blueprint.structuredData"]
  Current --> ReviewDraft
  Mode -- "targeted" --> Issues["加载选定 snapshot issues\n校验 reviewedContentHash"]
  Issues --> Directed["先按指定 issues 修订"]
  Directed --> Shared["runChapterLifecycle"]
  ReviewDraft --> Shared
  Shared --> Review["五角色审校 / 自动修订 / 最佳稿"]
  Review --> Gate{"质量门禁通过?"}
  Gate -- "是，full" --> Facts["事实提取与去重"]
  Gate -- "否或 targeted 完成" --> Human["manuscript-approval"]
  Human -- "revise" --> DirectedAgain["以当前稿或上一稿为基线\n合并作者补充要求"]
  DirectedAgain --> Shared
  Human -- "approve\n可指定替换 artifact" --> Facts
  Human -- "reject / abandon" --> Restore["abandoned\n不覆盖当前定稿正文"]
  Facts --> ApproveFacts["approveFacts"]
  ApproveFacts --> Commit["commit 或 commitAuthorApproved"]
  Commit --> Revision["更新 Document/Revision\n创建 chapter memory"]
  Revision --> Enrich["enrichCharacters"]
  Enrich --> Done["completed"]
```

重审链路的关键不变量：

- 只处理 `document.status === "final"`，并拒绝与同章节活跃 workflow 并发。
- 不重新运行 context、blueprint、blueprint-approval 或初次 draft；历史 blueprint 的完整 `structuredData` 与当前定稿正文被包装成新 draft artifact。
- Load 步骤使用 `loadChapterPlanningContextSnapshot`（按 `blueprintId` 加载 PlanningContext 快照），而非正式生成阶段的 `loadChapterPlanningContext`；这使 review-stage 走 `contextPacketId` 路径，复用历史 blueprint 冻结的起始状态、长线约束和章节位置，跳过 context/blueprint/blueprint-approval/draft 阶段，对齐章节审校工作流复用契约。
- 完整重审可以从当前正文或作者提交稿开始；定向修复只能基于当前已保存正文和选中的有效 review issues。
- 保存于审核面板的作者编辑稿会替换本轮 `workflow_runs.payload.artifactId`；后续审批、事实提取和提交都使用替换后的 artifact。
- 定向修复完成后必经作者 manuscript approval；完整重审若质量门禁直接通过，可以自动提交。
- 事实提取使用 novelty/身份与来源边界去重，不能因“只是重审”跳过 facts、commit、chapter memory 或 character enrichment。

## 8. 模型路由与 external-MCP 分支

```mermaid
flowchart TD
  Stage["某个 activity 需要模型"] --> Package["compileStageContext\n完整 instruction + manifest"]
  Package --> Snapshot["读取本 workflow 的 ModelRoutingSnapshot"]
  Snapshot --> Candidate["按 purpose 选择 candidateIndex"]
  Candidate --> Available{"候选可由内部 provider 执行?"}
  Available -- "是" --> Call["generateText / generateStructured / embed / rerank"]
  Call --> Valid{"传输与结构校验通过?"}
  Valid -- "是" --> Materialize["保存 artifact/review/learning 与 prompt diagnostics"]
  Valid -- "否，可换候选" --> Next["candidateIndex + 1"]
  Next --> Candidate
  Available -- "否" --> Task["创建幂等 model_tasks\n保存完整 work package"]
  Task --> Claim["外部 MCP claim → heartbeat → submit/fail"]
  Claim --> Signal{"Temporal 收到 artifact 或 fail signal?"}
  Signal -- "artifact" --> ExternalMaterialize["materializeExternal*\n校验并持久化"]
  ExternalMaterialize --> Materialize
  Signal -- "fail" --> Next
  Signal -- "15 分钟无结果" --> Expire["expireExternalModelTask"]
  Expire --> Next
  Next -. "候选耗尽" .-> Failed["workflow failed"]
```

- 路由按 `ModelPurpose`，不按模块硬编码 provider；一次 workflow 使用冻结的 routing snapshot。
- 外部任务 ID 由 workflow、task、candidate 和输入 fingerprint 决定，重复执行不会创建不同语义的同一任务。
- Web Chat 类 API 接收一份完整 instruction；上下文在 Runtime 内编译，不拆成依赖远端会话记忆的多段提交。
- 外部 prompt diagnostics 是尽力而为记录，诊断写入失败不能阻塞真实 workflow signal。
- 每次候选失败或超时都推进 `candidateIndex`；候选全部耗尽才将所属阶段/工作流置为失败。

## 9. 提交、事实与记忆回写

```mermaid
flowchart LR
  Artifact["最佳 draft/revision artifact"] --> Facts["fact-extraction artifact"]
  Facts --> Claims["memory_claims\n事实与叙事元素"]
  Facts --> Narrative["foreshadowing / promises /\nnarrative state / payoff curve"]
  Artifact --> Commit["CommitService"]
  Claims --> Commit
  Commit --> Document["documents 当前正文与状态"]
  Commit --> DocRevision["manuscript_revisions 不可变版本"]
  Commit --> ChapterMemory["chapter_memories"]
  Commit --> Outbox["outbox / workflow summary"]
  Commit --> Objects["content object 引用"]
  ChapterMemory -. "索引" .-> Qdrant["Qdrant"]
  Claims -. "索引" .-> Qdrant
  DocRevision --> Enrich["character enrichment"]
  Enrich --> Entities["角色知识、动机、关系记录"]
```

### 9.1 核心产物与真源

| 数据/产物 | 主要真源 | 作用与约束 |
| --- | --- | --- |
| `workflow_runs`、`task_attempts`、events/outbox | PostgreSQL；Temporal 持运行历史 | UI 与客户端查询状态，`workflow_runs.id` 与 Temporal workflowId 对齐 |
| `PreflightPlan`、`MemoryBundle`、`SkillBundle`、`ExecutionBlueprint`、`ContextManifest` | PostgreSQL | 冻结一次创作运行的认知输入与来源 |
| `Artifact` 元数据 | PostgreSQL | 指向不可变内容对象，携带 fingerprint、baseRevision、task/attempt |
| 正文、prompt/response snapshot 等大对象 | S3/MinIO 或显式 file backend | 数据库保存 object key/hash；backend identity 与数据库绑定并 fail-closed |
| `manuscript_documents`、`manuscript_revisions` | PostgreSQL | 当前定稿投影与不可变版本历史；在领域层对应 Document/DocumentRevision，正式更新必须经过 `CommitService` |
| `memory_claims`、叙事状态、伏笔、承诺、爽点 | PostgreSQL | 权威记忆和叙事账本，带来源、叙事顺序和生命周期 |
| `chapter_memories` | PostgreSQL | 章节级压缩记忆，绑定 document revision |
| 语义向量 | Qdrant | 辅助召回；不是事实真源，可由 PostgreSQL 重建 |
| `learning_assessments`、`craft_rule_candidates`、receipts | PostgreSQL | 审核经验、改进候选、推广与回滚证据 |
| `prompt_executions` | PostgreSQL + 对象存储快照 | 记录实际 prompt manifest、路由、响应与到期信息 |

## 10. Learning、Skill 与提示词迭代闭环

```mermaid
flowchart TD
  Reviews["章节或故事弧 Review issues\n包含 warning / major / blocker"] --> Assess["assessRuntimeLearningWithModel"]
  Assess --> Conclusion{"conclusion"}
  Conclusion -- "no-shared-learning" --> RecordOnly["记录 assessment\n不创建通用规则"]
  Conclusion -- "propose-improvement" --> Validate["校验 symptom / failingLayer\nunderlyingMechanism / affectedInputClass\nboundaries / regressionRisks"]
  Validate --> Candidate["自动 createCraftRuleCandidate\n绑定 assessmentId"]
  Candidate --> Evidence["提交跨场景 evidence cases"]
  Evidence --> FoundationEval["foundation evaluate"]
  FoundationEval --> HumanReview["规则候选审核"]
  HumanReview --> Promote["promote：原子更新 skill/prompt + receipt"]
  Promote --> Regression["使用新版本重跑失败场景"]
  Regression -- "通过" --> Keep["保留 promoted 版本"]
  Regression -- "失败" --> Rollback["自动 rollback\n保留失败证据"]

  Reviews --> Experiment["runClosedLoop\n项目快照 → 隔离实验 workspace"]
  Experiment --> Baseline["共享章节 lifecycle 基线"]
  Baseline --> Iterate["buildIterationPrompt\n注入 issues + underlyingMechanism"]
  Iterate --> CandidateRun["实验版本重跑同场景"]
  CandidateRun --> Compare{"真实实验回归通过?"}
  Compare -- "否" --> NoPromotion["拒绝推广"]
  Compare -- "是" --> Bundle["CandidateBundle"]
  Bundle --> PromoteBundle["作者决策后 promote"]
  PromoteBundle --> PostRegression["正式库再次重跑"]
  PostRegression -- "失败" --> Rollback
  PostRegression -- "通过" --> Keep
```

闭环边界：

1. 所有 review issue 都进入 learning 证据；warning 只有形成持续模式时才应提升为共享改进。
2. `propose-improvement` 必须说明底层机制和受影响输入类，不能只复述某一章的症状。
3. `recordLearning` 在 assessment 落库后立即构造幂等 CraftRule candidate，不能只发送事件而不形成候选。
4. Skill 迭代 prompt 使用数据库中真实 skill ID，并包含 `underlyingMechanism`；缺少机制时不得臆造通用规则。
5. CraftRule 和通用 evaluation 使用不同的 promotion service，但都要求可审计 receipt、回归验证与失败回滚。
6. 推广依据不是单一 A/B 分数，而是同失败场景的实际重跑；跨题材规则还应覆盖一个实质不同的反例或场景。

## 11. 状态、人工门禁与失败出口

### 11.1 Workflow run 状态

| 状态 | 含义 | 典型下一步 |
| --- | --- | --- |
| `accepted` / `pending` | 已持久化并准备由 Temporal 执行 | Worker 开始后进入 `running` |
| `running` | activity、模型调用或修订循环执行中 | 继续轮询 events/artifacts/prompt executions |
| `waiting-external` | 专用 workflow 正等待 external-MCP 回填 | 外部客户端 claim/submit/fail |
| `manual-review-required` | 等待作者 manuscript、fact、story-arc 或 plan 决策 | Web/MCP 发 signal 或正式操作 |
| `completed` / `succeeded` | 流程完成，产物已按相应契约持久化 | 查看正文、版本、事实与学习结果 |
| `rejected` | 作者拒绝本轮章节候选 | 保留已有正式正文，不提交候选 |
| `abandoned` | 作者放弃本轮运行 | 终止当前候选链，保留原定稿 |
| `failed` | 不可恢复异常或候选耗尽 | 从 payload/error、events 和 prompt diagnostics 定位失败层 |
| `cancelled` | 用户取消运行 | 取消 Temporal，并过期所属 model tasks |

### 11.2 人工门禁

| 门禁 | 触发条件 | 允许操作 | 继续后的路径 |
| --- | --- | --- | --- |
| 规划 section 确认 | Foundation artifact 生成完成 | 编辑、重生成、批准 | 解锁依赖或标记下游 stale |
| 故事弧审批 | Web/manual 策略或 auto 未通过 | approve、edit、rebase、abandon | 批准后供章节滚动规划使用 |
| Manuscript approval | 质量门禁未通过、记忆需人工确认、定向修复完成 | approve、revise、reject、abandon；可先替换本轮 artifact | facts → commit，或回到 revision |
| Fact approval | `factApprovalMode=manual` 且存在 pending claims | 逐项 approve/reject，再确认继续；或放弃 | 批准 claims 后 commit |
| CraftRule review | 候选已具备 evidence/foundation 评估 | review、promote、reject/rollback | 推广后必须回归验证 |

## 12. 当前兼容分支与非主路径

- `chapter-context-refs-v1`、`chapter-review-context-refs-v1`：新运行通过 ID 引用冻结上下文；旧 Temporal history 仍能重放传完整对象的分支。
- `chapter-context-convergence-v1`、`chapter-review-context-convergence-v1`：新运行在终态候选汇总 learning；旧运行可能在各阶段评估并保留独立 reflection。
- 独立 `reflectOnDraft` 仅供旧 history 兼容。新运行依赖 writer self-check 与五角色正式审校，不应再把 reflection 设计成第二套提交证据。
- `chapter-targeted-revision-first-v1`：新定向修复先修订再正式审核；旧 history 可保持“先审核再定向修订”的确定性顺序。
- `blueprint-approval`、`deterministic-check` 是共享协议/UI 阶段标识，当前主 workflow 没有对应的独立人工等待 activity。
- 通用 `CreativeRun` 页面和 command router 可用于实验或 work item 管理；不能绕过 `novelIntentWorkflow`/`chapterReviewWorkflow` 直接改写正式章节。

## 13. 后续优化观察点

这些是应持续观察的系统边界，不是针对单个样例的修复清单：

| 观察点 | 需要持续回答的问题 | 建议证据 |
| --- | --- | --- |
| 上下文冻结与复用 | 同一轮 draft/review/revision 是否使用同一 Blueprint、Memory、Skill、PlanningContext 和路由快照；重复运行是否只在源变更时重算 | context/prompt fingerprint、artifact refs、retrieval run、Temporal history |
| 规划到正文的消费 | Foundation 与故事弧字段是否真的进入 blueprint/prompt，而非只存在数据库或 UI | `ContextManifest`、prompt snapshot、生成正文中的约束兑现 |
| 人工门禁可达性 | `manual-review-required` 是否在当前工作流视图直接提供决策；替换稿和决策是否绑定同一 artifact | workflow payload、UI 状态推导、signal 记录 |
| 幂等与并发 | project/bootstrap/intent/commit/review replacement 是否在重试、刷新和重复 signal 下保持单一结果 | idempotency key、workflowId、baseRevision、fingerprint、唯一约束 |
| 记忆覆盖与叙事顺序 | 检索失败、索引延迟、重审旧章节或改写事实时，是否会泄漏未来信息或保留孤儿 claims | narrative cutoff、source revision、claim lifecycle、memory gate |
| 模型降级 | 内部候选、外部 MCP、超时与候选切换是否保持相同 Schema、完整上下文和可诊断性 | model task、candidateIndex、prompt execution、materialize 校验 |
| 审校与修订收敛 | 阈值是否覆盖广泛章节功能；最佳稿回退是否避免分数改善但 blocker 回归，或 blocker 消失但总分波动 | 五角色原始 Review、每轮 score/issue、最终 artifact fingerprint |
| Learning 闭环 | issue 是否归因到最低共享层；候选是否覆盖受影响输入类并明确边界；推广后是否真实重跑失败场景 | learning assessment、candidate scope、evidence cases、receipt、回归产物 |
| 可观测性 | UI 的当前阶段是否来自真实 payload/events/artifacts；诊断过期后是否仍保留 manifest/fingerprint | workflow summaries、outbox、prompt execution retention |

改进时应先记录：观察症状、失败层、底层机制、受影响输入类、行为边界和回归风险；验证原失败场景以及至少一个实质不同的反例。提示词样例只能说明原则，不能成为标题、题材、角色名、章节号或固定短语的特判。

## 14. 源码索引

| 主题 | 主要实现 |
| --- | --- |
| Temporal 主流程、故事弧、CreativeRun、章节重审 | [`src/novel-v2/temporal/workflows.ts`](../../src/novel-v2/temporal/workflows.ts) |
| Workflow activities、模型物化、learning 自动 propose | [`src/novel-v2/temporal/activities.ts`](../../src/novel-v2/temporal/activities.ts) |
| 共享章节审校/修订/提交生命周期 | [`src/novel-v2/application/chapter-lifecycle.ts`](../../src/novel-v2/application/chapter-lifecycle.ts) |
| Foundation DAG 与正文前置规划门禁 | [`src/novel-v2/application/project-plan.ts`](../../src/novel-v2/application/project-plan.ts) |
| Bootstrap 与 CreativeRun 创建 | [`src/novel-v2/application/bootstrap.ts`](../../src/novel-v2/application/bootstrap.ts) |
| 故事弧启动服务 | [`src/novel-v2/application/story-arc-workflow.ts`](../../src/novel-v2/application/story-arc-workflow.ts) |
| 五角色、分数和修订阈值 | [`src/novel-v2/temporal/revision-policy.ts`](../../src/novel-v2/temporal/revision-policy.ts) |
| Learning 结构、机制分析与提示词 | [`src/novel-v2/learning-assessment.ts`](../../src/novel-v2/learning-assessment.ts) |
| CraftRule promote / regression / rollback | [`src/novel-v2/craft-rule/index.ts`](../../src/novel-v2/craft-rule/index.ts) |
| 隔离实验闭环 | [`src/novel-v2/evaluation/closed-loop.ts`](../../src/novel-v2/evaluation/closed-loop.ts) |
| HTTP 入口和 signal 路由 | [`scripts/novel-v2-api.ts`](../../scripts/novel-v2-api.ts) |
| MCP 工具入口 | [`src/novel-v2/mcp/handlers.ts`](../../src/novel-v2/mcp/handlers.ts) |
| Web 章节工作台和阶段展示 | [`src/pages/novel-v2/NovelPipelineBoard.tsx`](../../src/pages/novel-v2/NovelPipelineBoard.tsx) |

## 15. 文档维护清单

以下变更发生时必须同步更新本文：

1. 新增、删除或重排 Temporal workflow/activity/stage。
2. Foundation DAG、必需批准 section 或故事弧批次策略改变。
3. reviewer 角色、identity、评分门槛、修订轮数或最佳稿规则改变。
4. manuscript/fact approval 的触发条件、signal payload 或作者操作改变。
5. Artifact、DocumentRevision、fact、chapter memory、character enrichment 的提交顺序改变。
6. ModelPurpose、路由候选、external-MCP 超时/重试协议改变。
7. Learning candidate、promotion、回归验证或 rollback 契约改变。
8. PostgreSQL、对象存储、Qdrant 的真源边界改变。

维护时至少对照正式章节生成、已定稿重审、故事弧和 learning 四条链路，确认每条图都包含入口、人工门禁、失败出口和最终持久化结果。

/**
 * V2 MCP 工具定义：23 个工具的 inputSchema（JSON Schema draft-07）。
 *
 * 设计依据：AGENTS.md 架构阶段和 V2 MCP 工具契约。
 *
 * 与 v1 的区别：
 * - v1 含 novel_foundation_export，v2 替换为 novel_closed_loop_run（评估闭环）
 * - v2 全部基于 Postgres，inputSchema 严格校验入参
 *
 * 工具分组（23 个）：
 * - Run / Action 主体（7）
 * - Catalog / Receipt（3）
 * - Craft Rule 候选演进（7）
 * - 项目生命周期（3）
 * - 一键流程（2）
 * - 评估闭环（1，v2 新增）
 */
import type { ToolDefinition } from "./types";

// ===== 共享 Schema 片段 =====

const issueSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    severity: { type: "string", enum: ["blocker", "major", "warning"] },
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    evidence: { type: "string", minLength: 1 },
    dimension: { type: "string" },
    excerpt: { type: "string" },
    paragraph: { type: "number" },
    revisionRanges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
        },
        required: ["start", "end"],
        additionalProperties: false,
      },
    },
    rule: { type: "string" },
    sourceId: { type: "string" },
    suggestion: { type: "string" },
    rewriteExample: { type: "string" },
  },
  required: ["severity", "title", "evidence"],
  additionalProperties: false,
};

const reviewInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    subjectArtifactId: { type: "string", minLength: 1 },
    reviewer: { type: "string", enum: ["internal", "independent", "human"] },
    verdict: { type: "string", enum: ["passed", "revise", "blocked"] },
    issues: { type: "array", items: issueSchema },
    summary: { type: "string" },
  },
  required: ["subjectArtifactId", "reviewer", "verdict", "issues", "summary"],
  additionalProperties: false,
};

const workInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["generation", "revision", "review"] },
    taskKey: { type: "string" },
    targetId: { type: "string" },
    instruction: { type: "string", minLength: 1 },
    dependsOn: { type: "array", items: { type: "string" } },
    parameters: { type: "object", additionalProperties: true },
  },
  required: ["kind", "instruction"],
  additionalProperties: false,
};

const policySchema: Record<string, unknown> = {
  type: "object",
  properties: {
    maxRetries: { type: "integer", minimum: 0 },
    reviewGate: { type: "string", enum: ["manual", "auto", "none"] },
    autoAcceptThreshold: { type: "number" },
  },
  additionalProperties: false,
};

// ===== 工具名常量 =====

export const TOOL_NAMES = [
  // Run / Action 主体（7）
  "novel_run_create",
  "novel_run_get",
  "novel_action_list",
  "novel_action_execute",
  "novel_artifact_get",
  "novel_review_submit",
  "novel_run_complete",
  // Catalog / Receipt（3）
  "novel_catalog_get",
  "novel_receipt_get",
  "novel_rule_target_get",
  // Craft Rule 候选演进（7）
  "novel_rule_candidate_create",
  "novel_rule_candidate_get",
  "novel_rule_evidence_submit",
  "novel_rule_foundation_evaluate",
  "novel_rule_review_submit",
  "novel_rule_promote",
  "novel_rule_rollback",
  // 项目生命周期（3）
  "novel_project_create",
  "novel_project_list",
  "novel_project_delete",
  // 一键流程（3）
  "novel_bootstrap_run",
  "novel_chapter_review",
  "novel_chapter_generate",
  "novel_story_arc_start",
  "novel_story_arc_get",
  // 评估闭环（1，v2 新增）
  "novel_closed_loop_run",
  // Workflow 查询（2，新增）
  "novel_workflow_get",
  "novel_workflow_list",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// ===== 工具定义 =====

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ===== Run / Action 主体（7）=====

  {
    name: "novel_run_create",
    description: "创建 CreativeRun（创意执行运行）。初始状态 pending，按 mode（chapter/segment-auto）执行多章节或分段创作。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["chapter", "segment-auto"] },
        policy: policySchema,
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["projectId", "mode", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_run_get",
    description: "获取 CreativeRun 快照（run + work items + reviews + events）。支持 afterSequence 增量拉取事件。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        afterSequence: { type: "integer", minimum: 0 },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_action_list",
    description: "列出 CreativeRun 当前可执行的 action 列表（根据 run 状态与 work items 状态派生）。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_action_execute",
    description: "执行 CreativeRun action（work.start/accept/revise/retry/recover/review.request/review.submit/run.pause/resume/cancel/work.enqueue）。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        action: {
          type: "string",
          enum: [
            "work.start",
            "work.accept",
            "work.revise",
            "work.retry",
            "work.recover",
            "review.request",
            "review.submit",
            "run.pause",
            "run.resume",
            "run.cancel",
            "work.enqueue",
          ],
        },
        workItemId: { type: "string" },
        work: workInputSchema,
        instruction: { type: "string" },
        force: { type: "boolean" },
        idempotencyKey: { type: "string", minLength: 1 },
        review: reviewInputSchema,
      },
      required: ["runId", "action", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_artifact_get",
    description: "按 artifactId 获取持久化创作产物及其内容哈希、对象存储键和执行元数据。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        artifactId: { type: "string", minLength: 1 },
      },
      required: ["artifactId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_review_submit",
    description: "提交审核（review.submit）。若 run.policy.reviewGate=auto 且 gate 通过，自动 accept work item。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        workItemId: { type: "string", minLength: 1 },
        review: reviewInputSchema,
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["runId", "workItemId", "review", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_run_complete",
    description: "完成 CreativeRun。校验所有 work items 必须为 accepted 且无 blocker issue。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },

  // ===== Catalog / Receipt（3）=====

  {
    name: "novel_catalog_get",
    description: "获取项目目录（项目详情 + 文档列表 + creative runs），并行查询。支持 compact 精简模式与 documentStatus 过滤，避免大项目响应过重。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        compact: { type: "boolean", default: false, description: "true 时省略 documents 与 creativeRuns，只返回项目元数据 + latestRuns。用于快速确认项目状态" },
        documentStatus: {
          type: "array",
          items: { type: "string", enum: ["planned", "drafting", "reviewing", "final", "archived"] },
          description: "可选，按 status 过滤 documents（仅 compact=false 时生效）",
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_receipt_get",
    description: "获取晋升收据（查询 promotion_receipts 表）。",
    inputSchema: {
      type: "object",
      properties: {
        receiptId: { type: "string", minLength: 1 },
      },
      required: ["receiptId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_target_get",
    description: "获取规则目标的当前版本，支持 skill 与项目级 system-prompt。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        targetKind: { type: "string", enum: ["skill", "system-prompt"] },
        targetId: { type: "string", minLength: 1 },
        version: { type: "string" },
      },
      required: ["projectId", "targetKind", "targetId"],
      additionalProperties: false,
    },
  },

  // ===== Craft Rule 候选演进（7）=====

  {
    name: "novel_rule_candidate_create",
    description: "创建规则候选：基于当前 skill/system-prompt 版本快照（beforeText）与提案文本（afterText）创建候选，校验 scope 必填字段（observedSymptom/failingLayer/underlyingMechanism/affectedInputClass）并计算 proposedVersion=nextPatchVersion(beforeVersion)。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        targetKind: { type: "string", enum: ["skill", "system-prompt"] },
        targetId: { type: "string", minLength: 1 },
        afterText: { type: "string", minLength: 1 },
        rationale: { type: "string", minLength: 1 },
        scope: { type: "object", additionalProperties: true },
      },
      required: ["projectId", "targetKind", "targetId", "afterText", "rationale"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_candidate_get",
    description: "获取规则候选详情（含 scope/evidenceCases/reviews/learningSource/status 等）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
      },
      required: ["projectId", "candidateId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_evidence_submit",
    description: "提交规则候选证据：校验 baseline/candidate work item 存在于 creative_work_items，追加到 evidenceCases 并将 status 置为 evidencing。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
        scenarioClass: { type: "string", minLength: 1 },
        scenarioRole: { type: "string", enum: ["source-failure", "cross-scenario"] },
        baselineWorkItemId: { type: "string", minLength: 1 },
        candidateWorkItemId: { type: "string", minLength: 1 },
      },
      required: ["projectId", "candidateId", "scenarioClass", "scenarioRole", "baselineWorkItemId", "candidateWorkItemId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_foundation_evaluate",
    description: "在基础阶段评估规则候选：在指定 taskKey 下分别用 beforeText/afterText 执行 LLM，对比分数和 blocker/major，并记录带场景角色的回归证据。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
        taskKey: {
          type: "string",
          enum: ["project-positioning", "architecture", "story-bible", "characters", "relations", "worldview"],
        },
        scenarioClass: { type: "string", minLength: 1 },
        scenarioRole: { type: "string", enum: ["source-failure", "cross-scenario"] },
        instruction: { type: "string" },
      },
      required: ["projectId", "candidateId", "taskKey", "scenarioClass", "scenarioRole"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_review_submit",
    description: "提交规则候选审核：追加 review 到 reviews 数组，status 置为 reviewing；若 verdict=rejected 则直接置为 rejected。需要 status 已为 evidencing 或 reviewing。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
        role: { type: "string", minLength: 1 },
        reviewerId: { type: "string", minLength: 1 },
        reviewRunId: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        provider: { type: "string" },
        promptFingerprint: { type: "string" },
        verdict: { type: "string", enum: ["passed", "revise", "rejected"] },
        summary: { type: "string", minLength: 1 },
        concerns: { type: "array", items: { type: "string" } },
      },
      required: ["projectId", "candidateId", "role", "reviewerId", "reviewRunId", "model", "verdict", "summary"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_promote",
    description: "晋升规则候选：要求原失败场景和异构场景回归证据、通过审核和未漂移目标版本；晋升后重跑证据，回归失败自动回滚。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
      },
      required: ["projectId", "candidateId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_rollback",
    description: "回滚规则候选晋升：恢复 skill/system-prompt 的 beforeText/beforeVersion，并同步更新 receipt 与候选状态。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
      },
      required: ["projectId", "candidateId"],
      additionalProperties: false,
    },
  },

  // ===== 项目生命周期（3）=====

  {
    name: "novel_project_create",
    description: "一句话创意创建小说项目。premise 作为创意核心,自动派生标题,默认自动启动 10 阶段宏观规划；逐章蓝图由故事弧在创作过程中滚动生成。autoBootstrap=false 时仅创建项目不启动规划。若需对已存在项目重新启动规划,请使用 novel_bootstrap_run。",
    inputSchema: {
      type: "object",
      properties: {
        premise: { type: "string", minLength: 1, description: "一句话创意/故事梗概(必填,作为创作核心)" },
        title: { type: "string", description: "可选,项目标题。未提供则从 premise 自动派生(取第一句前 24 字)" },
        genre: { type: "string", description: "可选,题材标签(如 玄幻/都市/言情/科幻/悬疑),用于 resolveSkillBundle 匹配 applicableGenres" },
        autoBootstrap: { type: "boolean", description: "是否自动启动全书规划,默认 true" },
        includeChapterPlan: { type: "boolean", description: "兼容旧客户端，当前已忽略；宏观规划不再生成固定章节表" },
        objective: { type: "string", description: "可选,bootstrap 目标。未提供则用 premise 作为 objective" },
        reviewGate: {
          type: "string",
          enum: ["manual", "auto", "none"],
          description: "可选,foundation 10 阶段审核门禁。none=无门禁(默认,生成即接受);manual=每阶段生成后暂停,等待人工审核(reviewer=human 且 verdict=passed 才通过,期间可用 review.submit 提交独立审核 + work.revise 修订);auto=按最新 review 与 openIssues/score 自动判定(需先有 review)。架构阶段推荐 manual,由外部 LLM 逐阶段审核。",
        },
        progression: {
          type: "string",
          enum: ["automatic", "user-driven"],
          description: "可选,work item 推进方式。automatic=依赖就绪即自动推进(默认);user-driven=需显式请求才推进(配合 manual gate 做精细控制)",
        },
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["premise", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_project_list",
    description: "列出所有项目（按 updatedAt DESC）。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },

  {
    name: "novel_project_delete",
    description: "删除项目（级联删除所有关联数据）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },

  // ===== 一键流程（2）=====

  {
    name: "novel_bootstrap_run",
    description: "对已存在项目启动宏观全书规划。任务链结束于 plot-design；章节蓝图由 novel_story_arc_start 按故事弧滚动生成。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        objective: { type: "string", description: "可选,规划目标。未提供则默认'完成项目基础设定与全书规划'" },
        includeChapterPlan: { type: "boolean", description: "兼容旧客户端，当前已忽略；宏观规划不再生成全书章节表" },
        reviewGate: {
          type: "string",
          enum: ["manual", "auto", "none"],
          description: "可选,foundation 10 阶段审核门禁。none=无门禁(默认,生成即接受);manual=每阶段生成后暂停,等待人工审核(reviewer=human 且 verdict=passed 才通过,期间可用 review.submit 提交独立审核 + work.revise 修订);auto=按最新 review 与 openIssues/score 自动判定。架构阶段推荐 manual,由外部 LLM 逐阶段审核。",
        },
        progression: {
          type: "string",
          enum: ["automatic", "user-driven"],
          description: "可选,work item 推进方式。automatic=依赖就绪即自动推进(默认);user-driven=需显式请求才推进(配合 manual gate 做精细控制)",
        },
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["projectId", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_chapter_review",
    description: "启动章节审校工作流（从 review 阶段半截启动，复用正式生成的 review→revision→fact-extraction→commit 闭环）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        documentId: { type: "string", minLength: 1 },
        instruction: { type: "string" },
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["projectId", "documentId", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_chapter_generate",
    description: "生成已批准故事弧中的目标章节，并走完整审核修订闭环。未提供 documentId 时选择当前故事弧最早的 planned 章节。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        documentId: { type: "string", description: "可选，当前已批准故事弧中的目标章节 document" },
        chapterTitle: { type: "string", description: "兼容旧客户端，章节标题以已批准蓝图为准" },
        instruction: { type: "string", description: "可选,章节生成指令/特殊要求" },
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["projectId", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_story_arc_start",
    description: "依据当前宏观规划和定稿状态生成下一个顺序故事弧及整弧章节蓝图，由外部 LLM 审核并自动修订至通过。",
    inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1 }, authorIntent: { type: "string" } }, required: ["projectId"], additionalProperties: false },
  },
  {
    name: "novel_story_arc_get",
    description: "查询项目故事弧列表或指定故事弧、章节蓝图及当前审核状态。",
    inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1 }, arcId: { type: "string" } }, required: ["projectId"], additionalProperties: false },
  },

  // ===== 评估闭环（1，v2 新增）=====

  {
    name: "novel_closed_loop_run",
    description: "执行评估闭环（snapshot → experiment → skill-iteration → candidate → promote）。需要 ToolContext.model。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        documentId: { type: "string", minLength: 1 },
        dryRun: { type: "boolean" },
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["projectId", "documentId", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  // ===== Workflow 查询（2，新增）=====

  {
    name: "novel_workflow_get",
    description: "按 workflowId 查询单个 workflow run 状态（章节生成/章节审校/故事弧规划）。返回 workflow_runs 记录 + Temporal 运行时状态。workflowId 来自 novel_chapter_generate / novel_chapter_review 的返回值。",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", minLength: 1 },
      },
      required: ["workflowId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_workflow_list",
    description: "按 projectId 列出最新 workflow runs，按 updatedAt DESC 排序。支持 workflowType 过滤。轻量替代 novel_catalog_get 查章节生成历史。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        workflowType: { type: "string", description: "可选。常见值: novel-intent(章节生成)、chapter-review(章节审校)、story-arc-planning(故事弧规划)" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
];

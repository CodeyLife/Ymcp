import { createNovelProject, novelDb, recordBase, type NovelDatabase } from "./db";
import {
  createCreativeRun,
  enqueueCreativeWork,
  executeCreativeCommand,
  inspectCreativeRun,
  type CreativeExecutionDependencies,
  type CreativeReviewInput,
  type CreativeWorkInput,
} from "./creative-execution";
import type { CreativeRunPolicy, NovelGenerationTaskKey } from "./types";
import { NOVEL_GENERATION_TASKS, getGenerationTask } from "./generation";
import { listAvailableSkills, listSkillVersions } from "./skills";
import { BUILTIN_PROMPT_TEMPLATES, listPromptTemplates } from "./prompt-templates";
import {
  createCraftRuleCandidate,
  evaluateCraftRuleOnFoundation,
  inspectCraftRuleCandidate,
  promoteCraftRuleCandidate,
  recordCraftRuleEvidence,
  rollbackCraftRuleCandidate,
  submitCraftRuleReview,
  supportsChapterRuleEvaluation,
} from "./craft-rule-evolution";
import type { CraftRuleReviewRole, CraftRuleScopeAnalysis } from "./types";
import { startChapterReviewWorkflow } from "./workflow";

export const CREATIVE_TOOL_NAMES = [
  "novel_run_create",
  "novel_run_get",
  "novel_action_list",
  "novel_action_execute",
  "novel_artifact_get",
  "novel_review_submit",
  "novel_run_complete",
  "novel_catalog_get",
  "novel_receipt_get",
  "novel_rule_target_get",
  "novel_rule_candidate_create",
  "novel_rule_candidate_get",
  "novel_rule_evidence_submit",
  "novel_rule_foundation_evaluate",
  "novel_rule_review_submit",
  "novel_rule_promote",
  "novel_rule_rollback",
  // 项目生命周期与一键流程（无 projectId 路由到任意已连接宿主）
  "novel_project_create",
  "novel_project_list",
  "novel_project_delete",
  "novel_bootstrap_run",
  "novel_foundation_export",
  // 章节审校工作流入口：从 review 阶段半截启动，复用正式生成的 review→revision→commit 闭环。
  "novel_chapter_review",
] as const;

export type CreativeToolName = typeof CREATIVE_TOOL_NAMES[number];

const MUTATING_TOOLS = new Set<CreativeToolName>([
  "novel_run_create", "novel_action_execute", "novel_review_submit", "novel_rule_candidate_create",
  "novel_rule_evidence_submit", "novel_rule_foundation_evaluate", "novel_rule_review_submit", "novel_rule_promote", "novel_rule_rollback",
  "novel_project_create", "novel_project_delete", "novel_bootstrap_run", "novel_chapter_review",
]);

// 无 projectId 的工具（项目生命周期管理）：通过 broker.requestAnyConnected 路由到任意已连接浏览器宿主执行。
// 这类工具的幂等收据 key 使用 "__global__" 代替 projectId，仍保证幂等性。
export const GLOBAL_SCOPE_TOOL_NAMES = new Set<CreativeToolName>(["novel_project_create", "novel_project_list"]);
const GLOBAL_SCOPE_TOOLS = GLOBAL_SCOPE_TOOL_NAMES;

// bootstrap 任务链：novel_bootstrap_run 按 foundation → planning 顺序 enqueue 这 10 个任务，
// 前置依赖链由系统自动构造。LLM 通过 novel_action_execute work.start 逐个启动。
const BOOTSTRAP_TASK_CHAIN: NovelGenerationTaskKey[] = [
  "project-positioning",
  "architecture",
  "characters",
  "relations",
  "worldview",
  "plot-threads",
  "foreshadowing",
  "timeline",
  "story-control",
  "plot-design",
];

// 各 bootstrap 任务的依赖（在 chain 中相对索引）。依赖一旦失败，下游任务也会被 work.start 时拒绗
// 未列出的任务（review/story-bible/chapter-plan/scene-design/chapter-draft/chapter-workflow）由 LLM 通过 work.enqueue 手动入队
const BOOTSTRAP_TASK_DEPENDENCIES: Partial<Record<NovelGenerationTaskKey, NovelGenerationTaskKey[]>> = {
  "project-positioning": [],
  architecture: ["project-positioning"],
  characters: ["architecture"],
  relations: ["characters"],
  worldview: ["architecture"],
  "plot-threads": ["architecture", "characters", "relations"],
  foreshadowing: ["plot-threads"],
  timeline: ["architecture", "plot-threads"],
  "story-control": ["plot-threads", "foreshadowing", "timeline"],
  "plot-design": ["plot-threads", "foreshadowing", "timeline"],
};

export interface CreativeToolEnvelope {
  ok: true;
  tool: CreativeToolName;
  result: unknown;
}

export interface CreativeToolGatewayDependencies extends CreativeExecutionDependencies {
  db?: NovelDatabase;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (!value) throw new Error(`${key} 不能为空`);
  return value;
}

function normalizedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, normalizedValue(item)]));
}

async function requestFingerprint(tool: CreativeToolName, args: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(normalizedValue({ tool, args: { ...args, idempotencyKey: undefined } })));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseCreativeWorkInput(value: unknown): CreativeWorkInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("work 必须是对象");
  const work = value as Record<string, unknown>;
  const kind = requiredString(work, "kind");
  if (!(["generation", "plot-segment", "chapter-workflow"] as string[]).includes(kind)) throw new Error(`当前执行器不支持 work.kind：${kind}`);
  const instruction = requiredString(work, "instruction");
  const targetId = typeof work.targetId === "string" && work.targetId.trim() ? work.targetId.trim() : undefined;
  const parameters = work.parameters && typeof work.parameters === "object" && !Array.isArray(work.parameters) ? structuredClone(work.parameters as Record<string, unknown>) : {};
  const dependsOn = work.dependsOn === undefined ? undefined : Array.isArray(work.dependsOn) && work.dependsOn.every((item) => typeof item === "string") ? [...new Set(work.dependsOn as string[])] : (() => { throw new Error("work.dependsOn 必须是字符串数组"); })();
  if (kind === "generation") {
    const taskKey = requiredString(work, "taskKey") as CreativeWorkInput["taskKey"];
    getGenerationTask(taskKey!);
    return { kind, taskKey, targetId, instruction, parameters, dependsOn };
  }
  if (!targetId) throw new Error(`${kind} work 缺少 targetId`);
  return { kind: kind as "plot-segment" | "chapter-workflow", targetId, instruction, parameters, dependsOn };
}

async function projectCatalog(projectId: string, db: NovelDatabase) {
  const project = await db.projects.get(projectId);
  if (!project) throw new Error("项目不存在");
  const [architecture, segments, documents, workflows, skills, skillVersions, promptTemplates, candidates] = await Promise.all([
    db.architectures.where("projectId").equals(projectId).first(),
    db.outlineNodes.where("projectId").equals(projectId).sortBy("order"),
    db.documents.where("projectId").equals(projectId).sortBy("order"),
    db.workflowDefinitions.where("projectId").anyOf("__builtin__", projectId).toArray(),
    listAvailableSkills(projectId, db),
    listSkillVersions(projectId, db),
    listPromptTemplates(projectId, db),
    db.craftRuleCandidates.where("projectId").equals(projectId).reverse().sortBy("updatedAt"),
  ]);
  return {
    project: { id: project.id, title: project.title, premise: project.premise, genre: project.genre, status: project.status, settings: project.settings },
    phases: architecture?.phases ?? [],
    plotSegments: segments.map((item) => ({ id: item.id, phaseId: item.phaseId, title: item.title, summary: item.summary, order: item.order })),
    documents: documents.filter((item) => !item.deletedAt).map((item) => ({ id: item.id, plotSegmentId: item.plotSegmentId, title: item.title, summary: item.summary, order: item.order, status: item.status, targetWords: item.blueprint.targetWords })),
    generationTasks: NOVEL_GENERATION_TASKS.map((task) => ({ key: task.key, label: task.label, scope: task.scope, skillStage: task.skillStage })),
    supportedWorkKinds: ["generation", "plot-segment", "chapter-workflow"],
    workflows,
    skills: skills.map((skill) => ({ skillId: skill.skillId, version: skill.version, name: skill.name, description: skill.description, stages: skill.stages, source: skill.source, chapterEvaluationEligible: supportsChapterRuleEvaluation(skill.stages) })),
    skillVersions: skillVersions.map((skill) => ({ id: skill.id, skillId: skill.skillId, version: skill.version, projectId: skill.projectId, source: skill.source })),
    promptTemplates: promptTemplates.map((template) => ({ id: template.id, templateId: template.templateId, version: template.version, name: template.name, stages: template.stages, source: template.source, chapterEvaluationEligible: supportsChapterRuleEvaluation(template.stages) })),
    ruleCandidates: candidates.map((candidate) => ({ id: candidate.id, targetKind: candidate.targetKind, targetId: candidate.targetId, proposedVersion: candidate.proposedVersion, status: candidate.status, updatedAt: candidate.updatedAt })),
  };
}

async function assertRunScope(runId: string, projectId: string, db: NovelDatabase): Promise<void> {
  const run = await db.creativeRuns.get(runId);
  if (!run || run.projectId !== projectId) throw new Error("创作运行不属于当前 MCP 项目作用域");
}

async function assertCandidateScope(candidateId: string, projectId: string, db: NovelDatabase): Promise<void> {
  const candidate = await db.craftRuleCandidates.get(candidateId);
  if (!candidate || candidate.projectId !== projectId) throw new Error("规则候选不属于当前 MCP 项目作用域");
}

async function getArtifact(artifactId: string, projectId: string | undefined, runId: string | undefined, db: NovelDatabase): Promise<{ kind: string; value: unknown }> {
  const lookups = await Promise.all([
    db.proposals.get(artifactId),
    db.workflowArtifacts.get(artifactId),
    db.documents.get(artifactId),
    db.revisions.get(artifactId),
    db.creativeReviews.get(artifactId),
  ]);
  const kinds = ["proposal", "workflow-artifact", "document", "revision", "creative-review"];
  const index = lookups.findIndex((value) => Boolean(value) && (!projectId || (value as { projectId?: string }).projectId === projectId));
  if (index >= 0) return { kind: kinds[index], value: lookups[index] };
  if (projectId) {
    const work = await db.creativeWorkItems.where("projectId").equals(projectId)
      .and((item) => (!runId || item.creativeRunId === runId) && item.artifactRefs.includes(artifactId))
      .first();
    const closedLoopCandidate = work?.parameters.closedLoopCandidate as { id?: string } | undefined;
    if (work && closedLoopCandidate?.id === artifactId) {
      return { kind: "closed-loop-candidate", value: structuredClone(closedLoopCandidate) };
    }
  }
  throw new Error("创作产物不存在");
}

async function executeCreativeToolCore(
  tool: CreativeToolName,
  args: Record<string, unknown>,
  dependencies: CreativeToolGatewayDependencies = {},
): Promise<CreativeToolEnvelope> {
  const db = dependencies.db ?? novelDb;

  // ===== 项目生命周期与一键流程（无 projectId 工具走 GLOBAL_SCOPE 路由） =====
  if (tool === "novel_project_create") {
    const title = requiredString(args, "title");
    const premise = requiredString(args, "premise");
    const genreRaw = args.genre;
    if (!Array.isArray(genreRaw) || genreRaw.some((item) => typeof item !== "string")) throw new Error("genre 必须是字符串数组");
    const genre = genreRaw.map((item) => item.trim()).filter(Boolean);
    if (!genre.length) throw new Error("genre 不能为空");
    const project = await createNovelProject({ title, premise, genre }, db);
    return { ok: true, tool, result: { id: project.id, title: project.title, premise: project.premise, genre: project.genre, status: project.status, settings: project.settings } };
  }
  if (tool === "novel_project_list") {
    const projects = await db.projects.toArray();
    const summary = projects.map((project) => ({
      id: project.id,
      title: project.title,
      premise: project.premise,
      genre: project.genre,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      contentProfile: project.settings.contentProfile,
    }));
    return { ok: true, tool, result: { projects: summary } };
  }
  if (tool === "novel_project_delete") {
    const projectId = requiredString(args, "projectId");
    if (projectId === "__global__") throw new Error("不能删除 __global__ 保留 scope");
    await db.transaction("rw", db.tables, async () => {
      for (const table of db.tables) {
        if (table.name === "projects") await table.delete(projectId);
        else if (table.schema.indexes.some((index) => index.name === "projectId")) await table.where("projectId").equals(projectId).delete();
      }
    });
    return { ok: true, tool, result: { deleted: true, projectId } };
  }
  if (tool === "novel_bootstrap_run") {
    const projectId = requiredString(args, "projectId");
    const project = await db.projects.get(projectId);
    if (!project) throw new Error("项目不存在");
    const objective = typeof args.objective === "string" && args.objective.trim() ? args.objective.trim() : `Bootstrap foundation+planning for ${project.title}`;
    const includeChapterPlan = args.includeChapterPlan === true;
    const mode = args.mode === "manual" ? "manual" : "external";
    const run = await createCreativeRun({ projectId, mode, objective, policy: mode === "manual" ? { maxIterations: 2 } : undefined }, db);
    // 按 chain 顺序 enqueue，依赖链根据 BOOTSTRAP_TASK_DEPENDENCIES 解析为同 run 内 work item id
    const taskIdToWorkId = new Map<NovelGenerationTaskKey, string>();
    const chain: NovelGenerationTaskKey[] = [...BOOTSTRAP_TASK_CHAIN];
    if (includeChapterPlan) chain.push("chapter-plan");
    for (const taskKey of chain) {
      const task = getGenerationTask(taskKey);
      const deps = BOOTSTRAP_TASK_DEPENDENCIES[taskKey] ?? [];
      const dependsOn = deps
        .map((dep) => taskIdToWorkId.get(dep))
        .filter((id): id is string => Boolean(id));
      // chapter-plan 不在 BOOTSTRAP_TASK_DEPENDENCIES 中，默认依赖 plot-design
      const extraDeps = taskKey === "chapter-plan" ? [taskIdToWorkId.get("plot-design")].filter((id): id is string => Boolean(id)) : [];
      const work = await enqueueCreativeWork(run.id, {
        kind: "generation",
        taskKey,
        instruction: `${task.defaultInstruction}\n\n# 本次规划目标与跨阶段约束\n${objective}\n\n本阶段产物必须落实上述目标中与自身职责相关的约束；不得用阶段默认值覆盖明确的项目目标。`,
        dependsOn: [...dependsOn, ...extraDeps],
      }, db);
      taskIdToWorkId.set(taskKey, work.id);
    }
    return { ok: true, tool, result: await inspectCreativeRun(run.id, undefined, db) };
  }
  if (tool === "novel_foundation_export") {
    const projectId = requiredString(args, "projectId");
    const project = await db.projects.get(projectId);
    if (!project) throw new Error("项目不存在");
    const [architecture, characters, relations, plotThreads, foreshadowing, outlineNodes, documents, timelineEvents, entities] = await Promise.all([
      db.architectures.where("projectId").equals(projectId).first(),
      db.entities.where("projectId").equals(projectId).filter((entity) => entity.kind === "character").toArray(),
      db.relations.where("projectId").equals(projectId).toArray(),
      db.plotThreads.where("projectId").equals(projectId).toArray(),
      db.foreshadowing.where("projectId").equals(projectId).toArray(),
      db.outlineNodes.where("projectId").equals(projectId).sortBy("order"),
      db.documents.where("projectId").equals(projectId).sortBy("order"),
      db.timelineEvents.where("projectId").equals(projectId).toArray(),
      db.entities.where("projectId").equals(projectId).toArray(),
    ]);
    return {
      ok: true,
      tool,
      result: {
        project: { id: project.id, title: project.title, premise: project.premise, genre: project.genre, audience: project.audience, themes: project.themes, sellingPoints: project.sellingPoints, pov: project.pov, tense: project.tense, tone: project.tone, languageStyle: project.languageStyle, targetWords: project.targetWords, status: project.status, settings: project.settings },
        architecture: architecture ? { framework: architecture.framework, status: architecture.status, centralQuestion: architecture.centralQuestion, centralConflict: architecture.centralConflict, synopsis: architecture.synopsis, phases: architecture.phases, growthCurves: architecture.growthCurves } : null,
        characters: characters.map((entity) => ({ id: entity.id, name: entity.name, summary: entity.summary, description: entity.description, attributes: entity.attributes, lockedFacts: entity.lockedFacts })),
        relations: relations.map((relation) => ({ id: relation.id, fromEntityId: relation.fromEntityId, toEntityId: relation.toEntityId, relationType: relation.relationType, publicLabel: relation.publicLabel, privateTruth: relation.privateTruth, bond: relation.bond })),
        plotThreads: plotThreads.map((thread) => ({ id: thread.id, kind: thread.kind, title: thread.title, summary: thread.summary, status: thread.status, priority: thread.priority, participantIds: thread.participantIds, progress: thread.progress, nextMove: thread.nextMove })),
        foreshadowing: foreshadowing.map((item) => ({ id: item.id, title: item.title, clue: item.clue, truth: item.truth, status: item.status, urgency: item.urgency, notes: item.notes })),
        outlineNodes: outlineNodes.map((node) => ({ id: node.id, phaseId: node.phaseId, title: node.title, summary: node.summary, order: node.order })),
        documents: documents.filter((doc) => !doc.deletedAt).map((doc) => ({ id: doc.id, plotSegmentId: doc.plotSegmentId, title: doc.title, summary: doc.summary, order: doc.order, status: doc.status, blueprint: doc.blueprint })),
        timelineEvents: timelineEvents.map((event) => ({ id: event.id, title: event.title, storyDate: event.storyDate, duration: event.duration, narrativeOrder: event.narrativeOrder, participantIds: event.participantIds, description: event.description })),
        entityIndex: entities.map((entity) => ({ id: entity.id, kind: entity.kind, name: entity.name })),
      },
    };
  }

  if (tool === "novel_chapter_review") {
    // 章节审校 MCP 入口：从 review 阶段半截启动 WorkflowRun，复用正式生成的 review→revision→commit 闭环。
    // 前置条件（document.status==="final"、无活跃工作流、存在历史 blueprint）由 startChapterReviewWorkflow 强制校验。
    // externalDraft 支持外部 LLM 主动重写章节正文：提供时 draft artifact 用此内容替代 document.plainText，
    // 走标准 review→revision→commit 闭环审核重写质量，不直接覆盖正式稿。
    const projectId = requiredString(args, "projectId");
    const documentId = requiredString(args, "documentId");
    const instruction = typeof args.instruction === "string" && args.instruction.trim() ? args.instruction.trim() : undefined;
    const blocking = args.blocking === false ? false : true;
    const externalDraft = typeof args.externalDraft === "string" && args.externalDraft.trim() ? args.externalDraft.trim() : undefined;
    const run = await startChapterReviewWorkflow({ projectId, documentId, instruction, blocking, externalDraft }, db);
    return { ok: true, tool, result: { workflowRunId: run.id, projectId: run.projectId, targetDocumentId: run.targetDocumentId, status: run.status, currentStage: run.currentStage, externalDraftApplied: Boolean(externalDraft), repairMode: externalDraft ? "external-edit" : "regenerate" } };
  }

  if (tool === "novel_run_create") {
    const mode = args.mode === "manual" ? "manual" : "external";
    const run = await createCreativeRun({
      projectId: requiredString(args, "projectId"),
      mode,
      objective: requiredString(args, "objective"),
      policy: args.policy as Partial<CreativeRunPolicy> | undefined,
      baseSnapshotHash: typeof args.baseSnapshotHash === "string" ? args.baseSnapshotHash : undefined,
    }, db);
    return { ok: true, tool, result: await inspectCreativeRun(run.id, undefined, db) };
  }

  if (tool === "novel_catalog_get") {
    return { ok: true, tool, result: await projectCatalog(requiredString(args, "projectId"), db) };
  }
  if (tool === "novel_receipt_get") {
    const targetTool = requiredString(args, "targetTool");
    // GLOBAL_SCOPE_TOOLS（novel_project_create）的幂等收据使用 "__global__" 作为 projectId
    const projectId = GLOBAL_SCOPE_TOOLS.has(targetTool as CreativeToolName) ? "__global__" : requiredString(args, "projectId");
    const idempotencyKey = requiredString(args, "idempotencyKey");
    if (!CREATIVE_TOOL_NAMES.includes(targetTool as CreativeToolName) || !MUTATING_TOOLS.has(targetTool as CreativeToolName)) throw new Error("targetTool 必须是可变更创作工具");
    const receipt = await db.creativeToolReceipts.where("[projectId+tool+idempotencyKey]").equals([projectId, targetTool, idempotencyKey]).first();
    if (!receipt) throw new Error("幂等收据不存在");
    return { ok: true, tool, result: structuredClone(receipt) };
  }
  if (tool === "novel_rule_target_get") {
    const projectId = requiredString(args, "projectId");
    const targetKind = requiredString(args, "targetKind");
    const targetId = requiredString(args, "targetId");
    const version = typeof args.version === "string" && args.version.trim() ? args.version.trim() : undefined;
    if (targetKind === "skill") {
      const allowedProjects = new Set(["__builtin__", "__user__", projectId]);
      const versions = (await listSkillVersions(projectId, db)).filter((item) => item.skillId === targetId && allowedProjects.has(item.projectId));
      const selected = version ? versions.find((item) => item.version === version) : (await listAvailableSkills(projectId, db)).find((item) => item.skillId === targetId);
      if (!selected) throw new Error("目标 Skill 版本不存在");
      return { ok: true, tool, result: { targetKind, targetId, version: selected.version, name: selected.name, description: selected.description, stages: selected.stages, source: selected.source, text: selected.prompt, qualityChecks: selected.qualityChecks } };
    }
    if (targetKind === "system-prompt") {
      const projectVersions = await db.promptTemplateVersions.where("[projectId+templateId]").equals([projectId, targetId]).toArray();
      const versions = [...BUILTIN_PROMPT_TEMPLATES.filter((item) => item.templateId === targetId), ...projectVersions];
      const selected = version ? versions.find((item) => item.version === version) : (await listPromptTemplates(projectId, db)).find((item) => item.templateId === targetId);
      if (!selected) throw new Error("目标系统 Prompt 版本不存在");
      return { ok: true, tool, result: { targetKind, targetId, version: selected.version, name: selected.name, description: selected.description, stages: selected.stages, source: selected.source, text: selected.content } };
    }
    throw new Error("targetKind 必须是 skill 或 system-prompt");
  }
  if (tool === "novel_rule_candidate_create") {
    const candidate = await createCraftRuleCandidate({
      projectId: requiredString(args, "projectId"),
      targetKind: requiredString(args, "targetKind") as "skill" | "system-prompt",
      targetId: requiredString(args, "targetId"),
      afterText: requiredString(args, "afterText"),
      rationale: requiredString(args, "rationale"),
      scope: args.scope as CraftRuleScopeAnalysis,
    }, db);
    return { ok: true, tool, result: await inspectCraftRuleCandidate(candidate.id, db) };
  }
  if (tool === "novel_rule_candidate_get") {
    const candidateId = requiredString(args, "candidateId");
    await assertCandidateScope(candidateId, requiredString(args, "projectId"), db);
    return { ok: true, tool, result: await inspectCraftRuleCandidate(candidateId, db) };
  }
  if (tool === "novel_rule_foundation_evaluate") {
    const candidateId = requiredString(args, "candidateId");
    await assertCandidateScope(candidateId, requiredString(args, "projectId"), db);
    const candidate = await evaluateCraftRuleOnFoundation({
      candidateId,
      taskKey: requiredString(args, "taskKey") as "project-positioning" | "architecture" | "story-bible" | "characters" | "relations" | "worldview",
      scenarioClass: requiredString(args, "scenarioClass"),
      instruction: typeof args.instruction === "string" ? args.instruction : undefined,
    }, {}, db);
    return { ok: true, tool, result: { candidate, gate: (await inspectCraftRuleCandidate(candidate.id, db)).gate } };
  }
  if (tool === "novel_rule_evidence_submit") {
    const candidateId = requiredString(args, "candidateId");
    await assertCandidateScope(candidateId, requiredString(args, "projectId"), db);
    const candidate = await recordCraftRuleEvidence({ candidateId, scenarioClass: requiredString(args, "scenarioClass"), baselineWorkItemId: requiredString(args, "baselineWorkItemId"), candidateWorkItemId: requiredString(args, "candidateWorkItemId") }, db);
    return { ok: true, tool, result: { candidate, gate: (await inspectCraftRuleCandidate(candidate.id, db)).gate } };
  }
  if (tool === "novel_rule_review_submit") {
    const candidateId = requiredString(args, "candidateId");
    await assertCandidateScope(candidateId, requiredString(args, "projectId"), db);
    const candidate = await submitCraftRuleReview({ candidateId, role: requiredString(args, "role") as CraftRuleReviewRole, reviewer: "external-llm", reviewerId: requiredString(args, "reviewerId"), reviewRunId: requiredString(args, "reviewRunId"), model: requiredString(args, "model"), provider: typeof args.provider === "string" ? args.provider : undefined, promptFingerprint: typeof args.promptFingerprint === "string" ? args.promptFingerprint : undefined, verdict: requiredString(args, "verdict") as "passed" | "revise" | "rejected", summary: requiredString(args, "summary"), concerns: Array.isArray(args.concerns) ? args.concerns.filter((item): item is string => typeof item === "string") : [] }, db);
    return { ok: true, tool, result: { candidate, gate: (await inspectCraftRuleCandidate(candidate.id, db)).gate } };
  }
  if (tool === "novel_rule_promote") {
    const candidateId = requiredString(args, "candidateId");
    await assertCandidateScope(candidateId, requiredString(args, "projectId"), db);
    const candidate = await promoteCraftRuleCandidate(candidateId, db);
    return { ok: true, tool, result: { candidate, gate: (await inspectCraftRuleCandidate(candidate.id, db)).gate } };
  }
  if (tool === "novel_rule_rollback") {
    const candidateId = requiredString(args, "candidateId");
    await assertCandidateScope(candidateId, requiredString(args, "projectId"), db);
    return { ok: true, tool, result: await rollbackCraftRuleCandidate(candidateId, db) };
  }

  const runId = requiredString(args, "runId");
  const projectId = requiredString(args, "projectId");
  await assertRunScope(runId, projectId, db);
  if (tool === "novel_run_get") {
    const afterSequence = typeof args.afterSequence === "number" ? args.afterSequence : undefined;
    return { ok: true, tool, result: await inspectCreativeRun(runId, afterSequence, db) };
  }
  if (tool === "novel_action_list") {
    const snapshot = await inspectCreativeRun(runId, undefined, db);
    return { ok: true, tool, result: { run: snapshot.run, actions: snapshot.nextActions, reviewGates: snapshot.reviewGates } };
  }
  if (tool === "novel_action_execute") {
    const action = requiredString(args, "action");
    if (action === "work.enqueue") {
      const work = await enqueueCreativeWork(runId, parseCreativeWorkInput(args.work), db);
      return { ok: true, tool, result: { work, snapshot: await inspectCreativeRun(runId, undefined, db) } };
    }
    if (!["work.start", "work.revise", "work.retry", "work.recover", "work.accept", "review.request", "run.pause", "run.resume", "run.cancel"].includes(action)) {
      throw new Error(`不支持的创作动作：${action}`);
    }
    const idempotencyKey = requiredString(args, "idempotencyKey");
    const command = action.startsWith("run.")
      ? { runId, type: action as "run.pause" | "run.resume" | "run.cancel", idempotencyKey }
      : action === "work.revise" || action === "work.retry"
        ? { runId, type: action as "work.revise" | "work.retry", workItemId: requiredString(args, "workItemId"), instruction: typeof args.instruction === "string" ? args.instruction : undefined, idempotencyKey }
        : action === "work.recover"
          ? { runId, type: "work.recover" as const, workItemId: requiredString(args, "workItemId"), force: args.force === true, idempotencyKey }
        : { runId, type: action as "work.start" | "work.accept" | "review.request", workItemId: requiredString(args, "workItemId"), idempotencyKey };
    return { ok: true, tool, result: await executeCreativeCommand(command, dependencies) };
  }
  if (tool === "novel_artifact_get") {
    return { ok: true, tool, result: await getArtifact(requiredString(args, "artifactId"), projectId, runId, db) };
  }
  if (tool === "novel_review_submit") {
    const workItemId = requiredString(args, "workItemId");
    const idempotencyKey = requiredString(args, "idempotencyKey");
    const review = args.review as CreativeReviewInput | undefined;
    if (!review || typeof review !== "object") throw new Error("review 不能为空");
    if (review.reviewer !== "external-llm" && review.reviewer !== "user") throw new Error("审核 reviewer 必须为 external-llm 或 user");
    return { ok: true, tool, result: await executeCreativeCommand({ runId, type: "review.submit", workItemId, idempotencyKey, review }, dependencies) };
  }
  if (tool === "novel_run_complete") {
    const snapshot = await inspectCreativeRun(runId, undefined, db);
    if (!snapshot.workItems.length) throw new Error("创作运行没有工作项，不能完成");
    if (snapshot.workItems.some((work) => work.status !== "completed" && work.status !== "cancelled")) {
      throw new Error("创作运行仍有未完成工作项");
    }
    if (Object.values(snapshot.reviewGates).some((gate) => gate.openIssues.some((issue) => issue.severity === "blocker" || issue.severity === "major"))) {
      throw new Error("创作运行仍有未解决的 blocker/major");
    }
    return { ok: true, tool, result: snapshot };
  }
  throw new Error(`未知创作工具：${tool satisfies never}`);
}

export async function executeCreativeTool(
  tool: CreativeToolName,
  args: Record<string, unknown>,
  dependencies: CreativeToolGatewayDependencies = {},
): Promise<CreativeToolEnvelope> {
  if (!MUTATING_TOOLS.has(tool)) return executeCreativeToolCore(tool, args, dependencies);
  const db = dependencies.db ?? novelDb;
  // GLOBAL_SCOPE_TOOLS（novel_project_create）没有 projectId 参数；用保留 scope "__global__" 作为收据主键。
  const projectId = GLOBAL_SCOPE_TOOLS.has(tool) ? "__global__" : requiredString(args, "projectId");
  const idempotencyKey = requiredString(args, "idempotencyKey");
  const fingerprint = await requestFingerprint(tool, args);
  const receiptKey: [string, string, string] = [projectId, tool, idempotencyKey];
  let receipt = await db.creativeToolReceipts.where("[projectId+tool+idempotencyKey]").equals(receiptKey).first();
  let claimed = false;
  if (!receipt) {
    const startedAt = Date.now();
    try {
      const id = await db.creativeToolReceipts.add({
        ...recordBase(projectId),
        tool,
        idempotencyKey,
        requestFingerprint: fingerprint,
        status: "pending",
        startedAt,
      });
      receipt = await db.creativeToolReceipts.get(id);
      claimed = true;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConstraintError") throw error;
      receipt = await db.creativeToolReceipts.where("[projectId+tool+idempotencyKey]").equals(receiptKey).first();
    }
  }
  if (!receipt) throw new Error("无法领取幂等执行权");
  if (receipt.requestFingerprint !== fingerprint) throw new Error("idempotencyKey 已用于不同请求");
  if (receipt.status === "completed") return structuredClone(receipt.result) as CreativeToolEnvelope;
  if (receipt.status === "failed") throw new Error(`该幂等请求此前执行失败：${receipt.error ?? "未知错误"}`);
  if (!claimed) throw new Error("该幂等请求正在执行中，请稍后查询运行状态");

  // The durable pending row is written before the workflow starts. A crash may require
  // operator reconciliation, but reusing the key can never replay an unknown side effect.
  try {
    const result = await executeCreativeToolCore(tool, args, dependencies);
    await db.creativeToolReceipts.update(receipt.id, {
      status: "completed",
      result: structuredClone(result),
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.creativeToolReceipts.update(receipt.id, {
      status: "failed",
      error: message,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });
    throw error;
  }
}

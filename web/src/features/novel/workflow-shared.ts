import { DEFAULT_CHAPTER_TARGET_WORDS, novelDb, recordBase } from "./db";
import type {
  AgentRun,
  ChapterBlueprint,
  NovelAgentRole,
  QualityDimension,
  WorkflowArtifact,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStage,
} from "./types";

/**
 * 工作流共享模块：从 workflow.ts 抽取的常量、schema、工具函数。
 * 独立为单独模块以打破 workflow.ts ↔ workflow-stages/ 的循环依赖。
 *
 * 依赖约束：本模块只依赖 ./db 和 ./types，不依赖 ./workflow 或 ./workflow-stages。
 */

export const CHAPTER_WORKFLOW_ID = "standard-chapter-v2";

export const BUILTIN_CHAPTER_WORKFLOW: WorkflowDefinition = {
  id: `builtin:${CHAPTER_WORKFLOW_ID}`,
  projectId: "__builtin__",
  schemaVersion: 2,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  createdBy: "system",
  updatedBy: "system",
  workflowId: CHAPTER_WORKFLOW_ID,
  name: "标准章节创作",
  description: "蓝图审批、正文生成、五类审校、定向修订、正文审批和事实回写。",
  stages: ["context", "blueprint", "blueprint-approval", "draft", "deterministic-check", "review", "revision", "manuscript-approval", "fact-extraction", "fact-approval", "commit", "character-enrichment"],
  requiredSkillIds: ["story-facts-invariant", "chapter-blueprint", "embodied-prose", "serial-rhythm", "continuity-audit", "style-specificity-audit", "plot-pacing-audit", "fact-delta-extraction"],
  maxAutoRevisions: 2,
  qualityThreshold: 3.7,
  builtin: true,
};

export function shouldAutoRevise(params: { passed: boolean; iteration: number; maxIterations: number; previousScore?: number; currentScore: number }) {
  const improvement = params.previousScore === undefined ? Number.POSITIVE_INFINITY : params.currentScore - params.previousScore;
  return !params.passed && params.iteration < params.maxIterations && improvement >= 0.15;
}

export const blueprintSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "objective", "startingState", "beats", "endingHook", "characters", "locations", "informationRelease", "mustHappen", "flexible", "forbidden"],
  properties: {
    title: { type: "string" }, objective: { type: "string" }, startingState: { type: "string" },
    beats: { type: "array", minItems: 4, maxItems: 10, items: { type: "object", additionalProperties: false, required: ["action", "emotion", "outcome"], properties: { action: { type: "string" }, emotion: { type: "string" }, outcome: { type: "string" } } } },
    endingHook: { type: "string" }, characters: { type: "array", items: { type: "string" } }, locations: { type: "array", items: { type: "string" } },
    informationRelease: { type: "array", items: { type: "string" } }, mustHappen: { type: "array", items: { type: "string" } }, flexible: { type: "array", items: { type: "string" } }, forbidden: { type: "array", items: { type: "string" } },
  },
};

const qualityDimensions: QualityDimension[] = ["plot", "characterVoice", "sceneEmbodiment", "dialogue", "pacing", "specificity", "hookPayoff", "continuity"];

export const reviewerSchema = {
  type: "object", additionalProperties: false, required: ["scores", "issues"],
  properties: {
    scores: { type: "object", additionalProperties: false, properties: Object.fromEntries(qualityDimensions.map((item) => [item, { type: "number", minimum: 0, maximum: 5 }])) },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["dimension", "severity", "title", "description", "revisionRanges", "rule", "suggestion"], properties: {
      dimension: { enum: qualityDimensions }, severity: { enum: ["blocker", "major", "warning"] }, title: { type: "string" }, description: { type: "string" }, excerpt: { type: "string" }, paragraph: { type: "integer", minimum: 1 }, revisionRanges: { type: "array", items: { type: "object", additionalProperties: false, required: ["start", "end"], properties: { start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } } } }, rule: { type: "string" }, sourceId: { type: "string" }, suggestion: { type: "string" },
    } } },
  },
};

export const factSchema = {
  type: "object", additionalProperties: false, required: ["summary", "facts"], properties: {
    summary: { type: "string" },
    facts: { type: "array", items: { type: "object", additionalProperties: false, required: ["targetTable", "field", "subject", "predicate", "object", "polarity", "truthStatus", "timeMode", "humanReadable", "after", "evidence", "confidence", "novelty", "conflict"], properties: {
      targetTable: { enum: ["projects", "entities", "relations", "outlineNodes", "plotThreads", "foreshadowing", "timelineEvents", "snapshots"] }, targetId: { type: "string" }, field: { type: "string" }, before: {}, after: {},
      subject: { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { enum: ["project", "entity", "relation", "outline", "scene", "thread", "foreshadowing", "timeline"] }, id: { type: "string" } } },
      predicate: { type: "string" },
      object: { type: "object", additionalProperties: false, required: ["kind", "value"], properties: { kind: { enum: ["entity-ref", "string", "number", "boolean", "json"] }, value: {} } },
      polarity: { enum: ["affirmed", "negated"] }, truthStatus: { enum: ["objective", "claim", "contested", "open-question"] }, timeMode: { enum: ["timeless", "point", "interval", "open-ended", "unknown"] },
      validFrom: { $ref: "#/$defs/storyPoint" }, validTo: { $ref: "#/$defs/storyPoint" }, humanReadable: { type: "string" },
      knowledgeDeltas: { type: "array", items: { type: "object", additionalProperties: false, required: ["characterId", "stance"], properties: { characterId: { type: "string" }, stance: { enum: ["known", "suspected", "mistaken", "unknown"] }, learnedAt: { $ref: "#/$defs/storyPoint" } } } },
      evidence: { type: "string" }, paragraph: { type: "integer", minimum: 1 }, confidence: { type: "number", minimum: 0, maximum: 1 }, novelty: { enum: ["new", "update", "duplicate"] }, conflict: { type: "boolean" },
    } } },
  },
  $defs: {
    storyPoint: { type: "object", additionalProperties: false, required: ["precision"], properties: {
      chapterId: { type: "string" }, sceneId: { type: "string" }, narrativeOrder: { type: "number" }, absoluteDate: { type: "string" }, anchorEventId: { type: "string" },
      relativeOffset: { type: "object", additionalProperties: false, required: ["value", "unit"], properties: { value: { type: "number" }, unit: { enum: ["minute", "hour", "day", "week", "month", "year"] } } },
      precision: { enum: ["exact", "approximate", "range", "unknown"] },
    } },
  },
};

export function blueprintMarkdown(data: Record<string, unknown>, targetWords = DEFAULT_CHAPTER_TARGET_WORDS) {
  const beats = data.beats as Array<{ action: string; emotion: string; outcome: string }>;
  return `# ${data.title}\n\n## 目标字数\n${targetWords} 字\n\n## 章节目标\n${data.objective}\n\n## 起点\n${data.startingState}\n\n## 节拍\n${beats.map((beat, index) => `${index + 1}. **行动**：${beat.action}\n   - 情绪：${beat.emotion}\n   - 结果：${beat.outcome}`).join("\n")}\n\n## 章尾驱动力\n${data.endingHook}\n\n## 必须发生\n${(data.mustHappen as string[]).map((item) => `- ${item}`).join("\n")}\n\n## 禁止事项\n${(data.forbidden as string[]).map((item) => `- ${item}`).join("\n") || "- 无"}`;
}

export function asBlueprint(data: Record<string, unknown>, existing?: ChapterBlueprint): ChapterBlueprint {
  const beats = data.beats as Array<{ action: string; emotion: string; outcome: string }>;
  return {
    objective: String(data.objective),
    povCharacterId: existing?.povCharacterId,
    locationIds: existing?.locationIds ?? [],
    characterIds: existing?.characterIds ?? [],
    conflict: beats.map((item) => item.action).join(" → "),
    informationRelease: data.informationRelease as string[],
    mustHappen: data.mustHappen as string[],
    flexible: data.flexible as string[],
    forbidden: data.forbidden as string[],
    targetWords: existing?.targetWords ?? DEFAULT_CHAPTER_TARGET_WORDS,
  };
}

export function stableArtifactBase(run: WorkflowRun, stage: WorkflowStage, kind: WorkflowArtifact["kind"]) {
  return { ...recordBase(run.projectId), id: `artifact:${run.id}:${stage}:${run.revisionIteration}:${kind}`, workflowRunId: run.id, stage, kind };
}

export type ArtifactInput = Omit<WorkflowArtifact, "id" | "schemaVersion" | "revision" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy" | "deletedAt">;

export async function saveArtifact(run: WorkflowRun, input: ArtifactInput) {
  const artifact: WorkflowArtifact = { ...stableArtifactBase(run, input.stage, input.kind), ...input };
  await novelDb.workflowArtifacts.put(artifact);
  return artifact;
}

export async function latestArtifact(runId: string, kinds: WorkflowArtifact["kind"][]) {
  const items = await novelDb.workflowArtifacts.where("workflowRunId").equals(runId).reverse().sortBy("createdAt");
  return items.find((item) => kinds.includes(item.kind));
}

export async function transition(run: WorkflowRun, stage: WorkflowStage, status: WorkflowRun["status"] = "running", changes: Partial<WorkflowRun> = {}) {
  const next: WorkflowRun = { ...run, ...changes, currentStage: stage, stageIndex: BUILTIN_CHAPTER_WORKFLOW.stages.indexOf(stage), status, revision: run.revision + 1, updatedAt: Date.now() };
  await novelDb.workflowRuns.put(next);
  return next;
}

export async function createAgentRecord(params: { run: WorkflowRun; role: NovelAgentRole; goal: string; skillRefs: string[] }) {
  const project = await novelDb.projects.get(params.run.projectId);
  if (!project) throw new Error("项目不存在");
  const agent: AgentRun = { ...recordBase(params.run.projectId), workflowRunId: params.run.id, goal: params.goal, status: "running", model: project.settings.textModel, promptVersion: "novel-workflow-v2", role: params.role, skillRefs: params.skillRefs, artifactRefs: [], attempt: params.run.revisionIteration + 1, startedAt: Date.now(), steps: [{ id: crypto.randomUUID(), title: params.goal, tool: "model.chat", status: "running" }] };
  await novelDb.agentRuns.add(agent);
  return { project, agent };
}

export async function finishAgent(agent: AgentRun, params: { promptHash: string; usage?: { inputTokens: number; outputTokens: number }; artifactId?: string }) {
  agent.status = "completed"; agent.finishedAt = Date.now(); agent.promptHash = params.promptHash; agent.usage = params.usage; agent.artifactRefs = params.artifactId ? [params.artifactId] : []; agent.steps[0].status = "completed";
  await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
}

export async function failAgent(agent: AgentRun, error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  agent.status = "failed"; agent.finishedAt = Date.now(); agent.steps[0].status = "failed"; agent.steps[0].error = message;
  await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
}

export async function failRun(run: WorkflowRun, error: unknown) {
  const message = error instanceof Error ? error.message : "未知工作流错误";
  const next = { ...run, status: "failed" as const, error: message, revision: run.revision + 1, updatedAt: Date.now() };
  await novelDb.workflowRuns.put(next);
  return next;
}

export async function createApprovalProposal(run: WorkflowRun, artifact: WorkflowArtifact, operation: string, title: string) {
  const existing = await novelDb.proposals.where("projectId").equals(run.projectId).and((item) => item.targetId === run.id && item.operation === operation && item.status === "pending").first();
  if (existing) return existing;
  const project = await novelDb.projects.get(run.projectId);
  const proposal = { ...recordBase(run.projectId), title, operation, targetId: run.id, status: "pending" as const, previewMarkdown: artifact.contentMarkdown, patches: [], items: [], contextPacketId: run.contextPacketId ?? "", artifactId: artifact.id, model: project?.settings.textModel ?? "" };
  await novelDb.proposals.add(proposal);
  return proposal;
}

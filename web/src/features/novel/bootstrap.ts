import { createNovelProject, novelDb } from "./db";
import {
  applyProposalItems,
  rejectProposal,
  runGenerationTask,
  updateProposalItemPayload,
} from "./generation";
import type { AIProposal, NovelGenerationTaskKey, ProposalItem, ProposalTargetTable } from "./types";

export type NovelBootstrapStage = "project-positioning" | "architecture";

export interface NovelBootstrapProgress {
  stage: NovelBootstrapStage;
  status: "waiting" | "running" | "completed" | "failed";
  error?: string;
}

export interface NovelBootstrapResult {
  projectId: string;
  completedStages: NovelBootstrapStage[];
}

export class NovelBootstrapError extends Error {
  readonly projectId: string;
  readonly completedStages: NovelBootstrapStage[];
  readonly stage?: NovelBootstrapStage;

  constructor(params: {
    message: string;
    projectId: string;
    completedStages: NovelBootstrapStage[];
    stage?: NovelBootstrapStage;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "NovelBootstrapError";
    this.projectId = params.projectId;
    this.completedStages = params.completedStages;
    this.stage = params.stage;
  }
}

const STAGES: NovelBootstrapStage[] = ["project-positioning", "architecture"];

const STAGE_INSTRUCTIONS: Record<NovelBootstrapStage, string> = {
  "project-positioning": "根据用户的核心创意建立完整作品定位。必须生成书名、润色后的核心创意、题材、目标读者、主题、核心卖点、叙事视角、叙事时态、整体基调和语言风格。润色可以增强表达，但不能改变原始故事承诺。",
  architecture: "根据已经确认的作品定位生成全书架构。必须给出核心问题、核心冲突、故事梗概和非空的阶段列表；阶段需要形成可继续扩展的完整故事走向。",
};

const STAGE_REQUIRED_FIELDS: Record<NovelBootstrapStage, Partial<Record<ProposalTargetTable, string[]>>> = {
  "project-positioning": {
    projects: ["title", "premise", "genre", "audience", "themes", "sellingPoints", "pov", "tense", "tone", "languageStyle"],
  },
  architecture: {
    architectures: ["centralQuestion", "centralConflict", "synopsis", "phases"],
  },
};

function provisionalTitle(coreIdea: string) {
  const firstClause = coreIdea.trim().split(/[，。！？!?\n]/, 1)[0]?.trim() ?? "";
  return firstClause.slice(0, 24) || "未命名小说";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function projectPayload(proposal: AIProposal) {
  return proposal.items.find((item) => item.targetTable === "projects")?.payload;
}

function architectureItem(proposal: AIProposal) {
  return proposal.items.find((item) => item.targetTable === "architectures");
}

function validateStageProposal(stage: NovelBootstrapStage, proposal: AIProposal) {
  if (stage === "project-positioning") {
    const payload = projectPayload(proposal);
    const requiredStrings = ["title", "premise", "audience", "pov", "tense", "tone", "languageStyle"];
    const requiredArrays = ["genre", "themes", "sellingPoints"];
    if (!payload
      || requiredStrings.some((key) => !isNonEmptyString(payload[key]))
      || requiredArrays.some((key) => !isNonEmptyStringArray(payload[key]))) {
      throw new Error("作品定位不完整，请重新生成");
    }
    return;
  }

  if (stage === "architecture") {
    const item = architectureItem(proposal);
    const payload = item?.payload;
    if (!item
      || !payload
      || !isNonEmptyString(payload.centralQuestion)
      || !isNonEmptyString(payload.centralConflict)
      || !isNonEmptyString(payload.synopsis)
      || !Array.isArray(payload.phases)
      || payload.phases.length === 0) {
      throw new Error("全书架构不完整，请重新生成");
    }
    return;
  }

}

async function completedBootstrapStages(projectId: string) {
  const [project, architecture, proposals] = await Promise.all([
    novelDb.projects.get(projectId),
    novelDb.architectures.where("projectId").equals(projectId).first(),
    novelDb.proposals.where("projectId").equals(projectId).toArray(),
  ]);
  const accepted = new Set(proposals.filter((proposal) => proposal.status === "accepted").map((proposal) => proposal.taskKey));
  const completed: NovelBootstrapStage[] = [];
  if (accepted.has("project-positioning")
    && project
    && isNonEmptyString(project.title)
    && isNonEmptyString(project.premise)
    && project.genre.length > 0) completed.push("project-positioning");
  if (accepted.has("architecture")
    && architecture?.status === "approved"
    && architecture.phases.length > 0) completed.push("architecture");
  return completed;
}

function progressFor(completed: NovelBootstrapStage[], active?: NovelBootstrapStage): NovelBootstrapProgress[] {
  return STAGES.map((stage) => ({
    stage,
    status: completed.includes(stage) ? "completed" : stage === active ? "running" : "waiting",
  }));
}

function abortIfRequested(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("生成已取消", "AbortError");
}

async function rejectPendingProposal(proposal?: AIProposal) {
  if (!proposal) return;
  const stored = await novelDb.proposals.get(proposal.id);
  if (stored?.status === "pending") await rejectProposal(proposal.id);
}

async function runAndApplyStage(params: {
  projectId: string;
  stage: NovelBootstrapStage;
  signal?: AbortSignal;
}) {
  let proposal: AIProposal | undefined;
  try {
    abortIfRequested(params.signal);
    const generated = await runGenerationTask({
      projectId: params.projectId,
      taskKey: params.stage as NovelGenerationTaskKey,
      instruction: STAGE_INSTRUCTIONS[params.stage],
      signal: params.signal,
      requiredPayloadFields: STAGE_REQUIRED_FIELDS[params.stage],
    });
    proposal = generated.proposal;
    validateStageProposal(params.stage, proposal);

    if (params.stage === "architecture") {
      const item = architectureItem(proposal)!;
      await updateProposalItemPayload(proposal.id, item.id, { ...item.payload, status: "approved" });
    }

    abortIfRequested(params.signal);
    const selectedIds = proposal.items.map((item: ProposalItem) => item.id);
    const applied = await applyProposalItems(proposal.id, selectedIds);
    if (applied.conflicts > 0 || applied.applied !== selectedIds.length) {
      throw new Error("自动采纳发生版本冲突，请继续生成");
    }
  } catch (error) {
    await rejectPendingProposal(proposal);
    throw error;
  }
}

export async function bootstrapNovelFromCoreIdea(params: {
  coreIdea: string;
  projectId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: NovelBootstrapProgress[]) => void;
}): Promise<NovelBootstrapResult> {
  const coreIdea = params.coreIdea.trim();
  if (!coreIdea) throw new Error("请输入核心创意");
  if (coreIdea.length > 2000) throw new Error("核心创意不能超过 2000 字");
  abortIfRequested(params.signal);

  const project = params.projectId
    ? await novelDb.projects.get(params.projectId)
    : await createNovelProject({ title: provisionalTitle(coreIdea), genre: [], premise: coreIdea });
  if (!project) throw new Error("待续建的小说项目不存在");

  let completed = await completedBootstrapStages(project.id);
  params.onProgress?.(progressFor(completed));
  let activeStage: NovelBootstrapStage | undefined;
  try {
    for (const stage of STAGES) {
      if (completed.includes(stage)) continue;
      activeStage = stage;
      params.onProgress?.(progressFor(completed, stage));
      await runAndApplyStage({ projectId: project.id, stage, signal: params.signal });
      completed = [...completed, stage];
      params.onProgress?.(progressFor(completed));
    }
    return { projectId: project.id, completedStages: completed };
  } catch (error) {
    const message = error instanceof Error ? error.message : "小说初始化失败";
    params.onProgress?.(progressFor(completed).map((item) => item.stage === activeStage
      ? { ...item, status: "failed", error: message }
      : item));
    throw new NovelBootstrapError({
      message,
      projectId: project.id,
      completedStages: completed,
      stage: activeStage,
      cause: error,
    });
  }
}

import { novelDb, type NovelDatabase } from "./db";
import {
  createCreativeRun,
  enqueueCreativeWork,
  executeCreativeCommand,
  inspectCreativeRun,
  type CreativeExecutionDependencies,
  type CreativeRunSnapshot,
} from "./creative-execution";
import type { ManuscriptDocument } from "./types";

export interface CreateSegmentAutomationInput {
  projectId: string;
  objective: string;
  plotSegmentId?: string;
  phaseId?: string;
  qualityThreshold?: number;
  maxIterations?: number;
}

export async function createSegmentAutomationRun(
  input: CreateSegmentAutomationInput,
  db: NovelDatabase = novelDb,
): Promise<CreativeRunSnapshot> {
  if (Boolean(input.plotSegmentId) === Boolean(input.phaseId)) {
    throw new Error("剧情段自动化必须且只能指定 plotSegmentId 或 phaseId");
  }
  const project = await db.projects.get(input.projectId);
  if (!project) throw new Error("项目不存在");
  let chapters: ManuscriptDocument[] = [];
  let segmentId: string | undefined;
  if (input.phaseId) {
    const architecture = await db.architectures.where("projectId").equals(input.projectId).first();
    if (!architecture?.phases.some((phase) => phase.id === input.phaseId)) throw new Error("目标幕不存在");
  } else {
    const segment = await db.outlineNodes.get(input.plotSegmentId!);
    if (!segment || segment.projectId !== input.projectId) throw new Error("剧情段不存在或不属于当前项目");
    segmentId = segment.id;
    chapters = await db.documents.where("projectId").equals(input.projectId)
      .and((document) => document.plotSegmentId === segment.id && !document.deletedAt)
      .sortBy("order");
    if (!chapters.length) throw new Error("剧情段尚未规划章节");
  }
  const run = await createCreativeRun({
    projectId: input.projectId,
    mode: "segment-auto",
    objective: input.objective,
    policy: {
      qualityThreshold: input.qualityThreshold ?? project.settings.qualityThreshold,
      maxIterations: input.maxIterations ?? project.settings.maxAutoRevisions,
    },
  }, db);

  if (input.phaseId) {
    await enqueueCreativeWork(run.id, {
      kind: "plot-segment",
      targetId: input.phaseId,
      instruction: input.objective,
      parameters: { source: "new-segment", phaseId: input.phaseId },
    }, db);
    return inspectCreativeRun(run.id, undefined, db);
  }

  let previousWorkId: string | undefined;
  for (const chapter of chapters) {
    const work = await enqueueCreativeWork(run.id, {
      kind: "chapter-workflow",
      targetId: chapter.id,
      instruction: chapter.blueprint.objective || chapter.summary || `完成${chapter.title}`,
      dependsOn: previousWorkId ? [previousWorkId] : [],
      parameters: { source: "existing-segment", plotSegmentId: segmentId, chapterOrder: chapter.order },
    }, db);
    previousWorkId = work.id;
  }
  return inspectCreativeRun(run.id, undefined, db);
}

export async function runSegmentAutomation(
  runId: string,
  options: { maxActions?: number; dependencies?: CreativeExecutionDependencies } = {},
): Promise<CreativeRunSnapshot> {
  const db = options.dependencies?.db ?? novelDb;
  const maxActions = Math.max(1, Math.min(500, options.maxActions ?? 100));
  for (let actionIndex = 0; actionIndex < maxActions; actionIndex += 1) {
    const snapshot = await inspectCreativeRun(runId, undefined, db);
    if (["completed", "failed", "cancelled"].includes(snapshot.run.status)) return snapshot;
    const next = snapshot.nextActions.find((action) => action.type === "work.revise" && action.workItemId)
      ?? snapshot.nextActions.find((action) => action.type === "work.start" && action.workItemId);
    if (!next?.workItemId) return snapshot;
    const work = snapshot.workItems.find((item) => item.id === next.workItemId)!;
    if (next.type === "work.revise") {
      const gate = snapshot.reviewGates[work.id];
      const latestArtifact = work.artifactRefs[0];
      const latestReview = [...snapshot.reviews]
        .filter((review) => review.workItemId === work.id && (!latestArtifact || review.subjectArtifactId === latestArtifact))
        .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
      const issueLines = (gate?.openIssues ?? []).map((issue, index) => [
        `${index + 1}. [${issue.severity}/${issue.dimension}] ${issue.title}`,
        `证据：${issue.evidence}`,
        `修改要求：${issue.suggestion}`,
      ].join("\n"));
      const revisionInstruction = [
        "依据本轮审核修订当前候选，并逐项解决下列问题。保留原任务目标和已经成立的内容，不复述审核文字。",
        latestReview?.summary ? `审核摘要：${latestReview.summary}` : "",
        ...issueLines,
      ].filter(Boolean).join("\n\n");
      await executeCreativeCommand({
        runId,
        type: "work.revise",
        workItemId: work.id,
        instruction: revisionInstruction,
        idempotencyKey: `segment-auto:${work.id}:revise:${work.iteration + 1}`,
      }, options.dependencies);
    } else {
      await executeCreativeCommand({
        runId,
        type: "work.start",
        workItemId: work.id,
        idempotencyKey: `segment-auto:${work.id}:iteration:${work.iteration}`,
      }, options.dependencies);
    }
  }
  throw new Error(`剧情段自动化超过单次最大动作数：${maxActions}`);
}

import { createHash } from "node:crypto";

export type ArcPlanningStatus = "generating" | "awaiting-review" | "approved" | "stale" | "failed";
export type ArcExecutionStatus = "planned" | "active" | "completed" | "abandoned";

export interface StoryArcPlan {
  title: string;
  objective: string;
  entryState: string;
  centralConflict: string;
  development: string[];
  resolution: string;
  exitState: string;
  plotThreadRefs: string[];
  foreshadowingRefs: string[];
  expectedChapterCount: number;
  phases: Array<{ title: string; objective: string; exitCondition: string }>;
  authorIntent?: string;
}
export type NarrativeArcPlan = StoryArcPlan;

export interface StoryArcBatchPlan {
  batchIndex: number;
  startChapterIndex: number;
  complete: boolean;
}

export interface StoryArcBatchRecord extends StoryArcBatchPlan {
  id: string;
  arcId: string;
  projectId: string;
  endChapterIndex: number;
  status: "generating" | "awaiting-review" | "approved" | "failed";
  entryFingerprint: string;
  sourceArtifactId?: string;
  approvedAt?: string;
}

export interface ChapterSceneBlueprint {
  title: string;
  summary: string;
  goal?: string;
  participants: string[];
  turn?: string;
  outcome?: string;
}

export interface ChapterBlueprint {
  id?: string;
  index: number;
  title: string;
  summary: string;
  chapterPurpose: string;
  dramaticQuestion: string;
  povCharacterId?: string;
  emotionalMovement: string;
  stateDeltaBudget: string;
  optionalBeats: string[];
  scenes: ChapterSceneBlueprint[];
  continuityConstraints: string[];
  setupRefs: string[];
  payoffRefs: string[];
  closingForce: string;
  freedom: string;
}

export {
  CHAPTER_PLAN_CHECK_DIMENSIONS,
  compileChapterPlanValidationReport,
} from "./story-arc-review-policy";
export type {
  ChapterPlanCheckDimension,
  ChapterPlanValidationCheck,
  ChapterPlanValidationReport,
} from "./story-arc-review-policy";

export interface StoryArcBundle {
  arc: NarrativeArcPlan;
  batch: StoryArcBatchPlan;
  chapters: ChapterBlueprint[];
}

export interface StoryArcRecord {
  id: string;
  projectId: string;
  volumeId: string;
  ordinal: number;
  planningStatus: ArcPlanningStatus;
  executionStatus: ArcExecutionStatus;
  arc: NarrativeArcPlan;
  chapters: ChapterBlueprintRecord[];
  batches: StoryArcBatchRecord[];
  sourceArtifactId?: string;
  blueprintArtifactId?: string;
  contextFingerprint?: string;
  reviewArtifactId?: string;
  reviewFingerprint?: string;
  editRevision: number;
  approvedAt?: string;
  completedAt?: string;
  abandonedAt?: string;
  updatedAt: string;
}

export interface ChapterBlueprintRecord extends ChapterBlueprint {
  id: string;
  arcId: string;
  projectId: string;
  documentId?: string;
  globalOrder: number;
  status: string;
  sourceArtifactId?: string;
  blueprintRevision: number;
}

export interface ChapterPlanningContext {
  projectId: string;
  arcId: string;
  chapterBlueprintId: string;
  macroPlanArtifacts: Array<{ id: string; taskKey: string; title: string; summary: string; payload: Record<string, unknown> }>;
  arc: NarrativeArcPlan;
  chapter: ChapterBlueprintRecord;
  neighbors: Array<Pick<ChapterBlueprintRecord, "id" | "globalOrder" | "title" | "summary" | "chapterPurpose">>;
  sourceArtifactIds: string[];
  fingerprint: string;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseStoryArcBundle(value: unknown): StoryArcBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("故事弧蓝图必须是对象");
  const root = value as Record<string, unknown>;
  const rawArc = root.arc;
  if (!rawArc || typeof rawArc !== "object" || Array.isArray(rawArc)) throw new Error("故事弧缺少 arc");
  const arcValue = rawArc as Record<string, unknown>;
  const title = typeof arcValue.title === "string" ? arcValue.title.trim() : "";
  const objective = typeof arcValue.objective === "string" ? arcValue.objective.trim() : "";
  if (!title || !objective) throw new Error("故事弧标题和创作目的不能为空");
  const rawChapters = Array.isArray(root.chapters) ? root.chapters : [];
  if (!rawChapters.length) throw new Error("故事弧至少需要一个章节蓝图");
  const chapters = rawChapters.map((raw, offset): ChapterBlueprint => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`第 ${offset + 1} 个章节蓝图格式错误`);
    const chapter = raw as Record<string, unknown>;
    const chapterTitle = typeof chapter.title === "string" ? chapter.title.trim() : "";
    const summary = typeof chapter.summary === "string" ? chapter.summary.trim() : "";
    if (!chapterTitle || !summary) throw new Error(`第 ${offset + 1} 个章节蓝图缺少标题或摘要`);
    const rawScenes = Array.isArray(chapter.scenes) ? chapter.scenes : [];
    return {
      id: typeof chapter.id === "string" ? chapter.id : undefined,
      index: offset + 1,
      title: chapterTitle,
      summary,
      chapterPurpose: typeof chapter.chapterPurpose === "string" ? chapter.chapterPurpose : "",
      dramaticQuestion: typeof chapter.dramaticQuestion === "string" ? chapter.dramaticQuestion : "",
      povCharacterId: typeof chapter.povCharacterId === "string" && chapter.povCharacterId.trim() ? chapter.povCharacterId : undefined,
      emotionalMovement: typeof chapter.emotionalMovement === "string" ? chapter.emotionalMovement : "",
      stateDeltaBudget: typeof chapter.stateDeltaBudget === "string" ? chapter.stateDeltaBudget : "",
      optionalBeats: strings(chapter.optionalBeats),
      scenes: rawScenes.map((scene, sceneIndex) => {
        const item = scene && typeof scene === "object" && !Array.isArray(scene) ? scene as Record<string, unknown> : {};
        return {
          title: typeof item.title === "string" ? item.title : `场景 ${sceneIndex + 1}`,
          summary: typeof item.summary === "string" ? item.summary : "",
          goal: typeof item.goal === "string" ? item.goal : undefined,
          participants: strings(item.participants),
          turn: typeof item.turn === "string" ? item.turn : undefined,
          outcome: typeof item.outcome === "string" ? item.outcome : undefined,
        };
      }),
      continuityConstraints: strings(chapter.continuityConstraints),
      setupRefs: strings(chapter.setupRefs),
      payoffRefs: strings(chapter.payoffRefs),
      closingForce: typeof chapter.closingForce === "string" ? chapter.closingForce : "",
      freedom: typeof chapter.freedom === "string" ? chapter.freedom : "允许使用背景、内省、情感积累和文学意象完成本章功能，不必机械执行节拍。",
    };
  });
  const rawBatch = root.batch && typeof root.batch === "object" && !Array.isArray(root.batch) ? root.batch as Record<string, unknown> : {};
  const batchIndex = Number.isInteger(rawBatch.batchIndex) && Number(rawBatch.batchIndex) > 0 ? Number(rawBatch.batchIndex) : 1;
  const startChapterIndex = Number.isInteger(rawBatch.startChapterIndex) && Number(rawBatch.startChapterIndex) > 0 ? Number(rawBatch.startChapterIndex) : 1;
  return {
    arc: {
      title,
      objective,
      entryState: typeof arcValue.entryState === "string" ? arcValue.entryState : "",
      centralConflict: typeof arcValue.centralConflict === "string" ? arcValue.centralConflict : "",
      development: strings(arcValue.development),
      resolution: typeof arcValue.resolution === "string" ? arcValue.resolution : "",
      exitState: typeof arcValue.exitState === "string" ? arcValue.exitState : "",
      plotThreadRefs: strings(arcValue.plotThreadRefs),
      foreshadowingRefs: strings(arcValue.foreshadowingRefs),
      expectedChapterCount: Math.max(chapters.length, Number.isInteger(arcValue.expectedChapterCount) ? Number(arcValue.expectedChapterCount) : chapters.length),
      phases: Array.isArray(arcValue.phases) ? arcValue.phases.map((phase) => {
        const item = phase && typeof phase === "object" && !Array.isArray(phase) ? phase as Record<string, unknown> : {};
        return { title: String(item.title ?? ""), objective: String(item.objective ?? ""), exitCondition: String(item.exitCondition ?? "") };
      }).filter((phase) => phase.title && phase.objective) : [],
      authorIntent: typeof arcValue.authorIntent === "string" && arcValue.authorIntent.trim() ? arcValue.authorIntent : undefined,
    },
    batch: { batchIndex, startChapterIndex, complete: rawBatch.complete === true },
    chapters,
  };
}

export function canGenerateNextStoryArcBatch(input: { plannedInBatch: number; finalizedInBatch: number; batchStatus: StoryArcBatchRecord["status"] }): boolean {
  if (input.batchStatus !== "approved" || input.plannedInBatch <= 0) return false;
  return input.finalizedInBatch / input.plannedInBatch >= 0.7;
}

export function planningContextFingerprint(value: Omit<ChapterPlanningContext, "fingerprint">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

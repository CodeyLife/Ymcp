import { createHash } from "node:crypto";
import { CHAPTER_NARRATIVE_SCALE_LEVELS, defaultChapterNarrativeScale, type ChapterNarrativeScale } from "./chapter-narrative-scale";

export type ArcPlanningStatus = "generating" | "awaiting-review" | "approved" | "stale" | "failed";
export type ArcExecutionStatus = "planned" | "active" | "completed" | "abandoned";

export const CHAPTER_NARRATIVE_FUNCTIONS = ["setup", "development", "relationship", "discovery", "confrontation", "payoff", "aftermath", "transition", "reflection"] as const;
export type ChapterNarrativeFunction = (typeof CHAPTER_NARRATIVE_FUNCTIONS)[number];
export { CHAPTER_NARRATIVE_SCALE_LEVELS, defaultChapterNarrativeScale } from "./chapter-narrative-scale";
export type { ChapterNarrativeScale, ChapterNarrativeScaleLevel } from "./chapter-narrative-scale";
export const THEME_TREATMENT_MODES = ["absent", "subtext", "foreground"] as const;
export type ThemeTreatmentMode = (typeof THEME_TREATMENT_MODES)[number];
export const THEME_CARRIERS = ["none", "choice", "consequence", "relationship", "world-reaction", "dialogue-conflict"] as const;
export type ThemeCarrier = (typeof THEME_CARRIERS)[number];
export const STAKE_KNOWLEDGE_BASES = ["planned", "committed", "observable-inference", "unknown"] as const;
export type StakeKnowledgeBasis = (typeof STAKE_KNOWLEDGE_BASES)[number];
export const PLAN_APPLICABILITY = ["not-applicable", "background", "active"] as const;
export type PlanApplicability = (typeof PLAN_APPLICABILITY)[number];

const STAKE_FIELDS = ["want", "leverage", "withholding", "failureCost"] as const;
type StakeField = (typeof STAKE_FIELDS)[number];

/**
 * Normalize knowledgeBasis enum values to match their corresponding text content.
 *
 * LLMs generating story arc bundles sometimes set knowledgeBasis[field]="unknown"
 * but still write content, or set a non-unknown basis but leave the text empty.
 * The validation contract requires: unknown → empty text, non-unknown → non-empty text.
 * This normalization fixes the inconsistency before validation by adjusting the
 * basis label to match the LLM's actual content:
 * - unknown + non-empty text → "planned" (LLM wrote content, so it intended a planned element)
 * - non-unknown + empty text → "unknown" (no content means truly unknown)
 *
 * This addresses the broader class of LLM schema-conformance failures around the
 * unknown↔empty-text constraint, not a single chapter, character, or stake field.
 */
export function normalizeStakeKnowledgeBasis<T extends Record<string, unknown>>(stake: T): T {
  const basis = stake.knowledgeBasis as Record<StakeField, StakeKnowledgeBasis> | undefined;
  if (!basis) return stake;
  const normalized = { ...basis };
  for (const field of STAKE_FIELDS) {
    const text = typeof stake[field] === "string" ? (stake[field] as string).trim() : "";
    if (normalized[field] === "unknown" && text) {
      normalized[field] = "planned";
    } else if (normalized[field] !== "unknown" && !text) {
      normalized[field] = "unknown";
    }
  }
  return { ...stake, knowledgeBasis: normalized };
}

function normalizeNonRebaseThematicTreatment(chapter: ChapterBlueprint): ChapterBlueprint {
  const treatment = chapter.thematicTreatment;
  if (!treatment) return chapter;
  const hasThemeMaterial = treatment.questionRefs.length > 0 || Boolean(treatment.evidenceChange.trim());
  if (treatment.mode === "absent") {
    return {
      ...chapter,
      thematicTreatment: { mode: "absent", questionRefs: [], carrier: "none", evidenceChange: "", expositionBoundary: "" },
    };
  }
  if (treatment.mode === "foreground") {
    const structurallySupported = treatment.carrier === "dialogue-conflict" && chapter.scenes.some((scene) => {
      const stakes = scene.participantStakes ?? [];
      const participantCount = new Set(stakes.map((stake) => stake.participant).filter((participant) => scene.participants.includes(participant))).size;
      return scene.participants.length >= 2 && participantCount >= 2 && Boolean(scene.opposition?.trim()) && Boolean(scene.turn?.trim());
    });
    if (!structurallySupported) {
      return {
        ...chapter,
        thematicTreatment: hasThemeMaterial
          ? {
            mode: "subtext",
            questionRefs: [...treatment.questionRefs],
            carrier: treatment.carrier === "none" || treatment.carrier === "dialogue-conflict" ? "choice" : treatment.carrier,
            evidenceChange: treatment.evidenceChange,
            expositionBoundary: treatment.expositionBoundary || "不得由作者或人物直接总结主题结论",
          }
          : { mode: "absent", questionRefs: [], carrier: "none", evidenceChange: "", expositionBoundary: "" },
      };
    }
  }
  if (treatment.mode === "subtext" && (treatment.carrier === "none" || treatment.carrier === "dialogue-conflict")) {
    return {
      ...chapter,
      thematicTreatment: hasThemeMaterial
        ? { ...treatment, carrier: "choice", expositionBoundary: treatment.expositionBoundary || "不得由作者或人物直接总结主题结论" }
        : { mode: "absent", questionRefs: [], carrier: "none", evidenceChange: "", expositionBoundary: "" },
    };
  }
  return chapter;
}

/**
 * Apply non-rebase story-arc normalization before deterministic validation.
 *
 * This covers broad schema-conformance failures caused by LLMs overfilling planning
 * fields: knowledgeBasis labels must match text content, and thematic foreground is
 * only allowed when the chapter structurally carries a multi-party dialogue conflict.
 * Unsupported foreground is downgraded to subtext/absent so a usable scene plan can
 * continue into review instead of aborting the workflow before artifacts exist.
 */
export function normalizeStoryArcStakes<T extends { chapters: Array<{ scenes: Array<{ participantStakes?: Array<Record<string, unknown>> }> }> }>(bundle: T): T {
  return {
    ...bundle,
    chapters: bundle.chapters.map((chapter) => ({
      ...normalizeNonRebaseThematicTreatment(chapter as ChapterBlueprint),
      scenes: chapter.scenes.map((scene) => ({
        ...scene,
        participantStakes: scene.participantStakes?.map((stake) => normalizeStakeKnowledgeBasis(stake)),
      })),
    })),
  };
}

export interface ThematicQuestion {
  id: string;
  question: string;
  opposingPressures: string;
  resolutionWindow: string;
}

export interface ThematicTreatment {
  mode: ThemeTreatmentMode;
  questionRefs: string[];
  carrier: ThemeCarrier;
  evidenceChange: string;
  expositionBoundary: string;
}

export interface CharacterFocus {
  characterRef: string;
  function: string;
  desire: string;
  action: string;
  cost: string;
}

export interface RomanceTreatment {
  status: PlanApplicability;
  stage: string;
  actionEvidence: string;
  boundary: string;
}

export interface HumorTreatment {
  status: PlanApplicability;
  opportunity: string;
  evidence: string;
  boundary: string;
}

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
  thematicQuestions?: ThematicQuestion[];
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
  opposition?: string;
  participants: string[];
  turn?: string;
  outcome?: string;
  cost?: string;
  participantStakes?: Array<{
    participant: string;
    want: string;
    leverage: string;
    withholding: string;
    failureCost: string;
    knowledgeBasis?: {
      want: StakeKnowledgeBasis;
      leverage: StakeKnowledgeBasis;
      withholding: StakeKnowledgeBasis;
      failureCost: StakeKnowledgeBasis;
    };
  }>;
}

export interface ChapterBlueprint {
  id?: string;
  index: number;
  title: string;
  summary: string;
  chapterPurpose: string;
  stateTransition?: { before: string; after: string; evidence: string };
  narrativeFunction?: ChapterNarrativeFunction;
  readerExperience?: string;
  thematicTreatment?: ThematicTreatment;
  worldRuleRefs: string[];
  characterFocus: CharacterFocus[];
  romanceTreatment: RomanceTreatment;
  humorTreatment: HumorTreatment;
  dramaticQuestion: string;
  povCharacterId?: string;
  emotionalMovement: string;
  stateDeltaBudget: string;
  narrativeScale?: ChapterNarrativeScale;
  optionalBeats: string[];
  scenes: ChapterSceneBlueprint[];
  continuityConstraints: string[];
  setupRefs: string[];
  payoffRefs: string[];
  unresolvedAtClose?: string[];
  closingForce: string;
  freedom: string;
}

export {
  ARC_PLAN_CHECK_DIMENSIONS,
  CHAPTER_PLAN_CHECK_DIMENSIONS,
  compileChapterPlanValidationReport,
} from "./story-arc-review-policy";
export { getApplicableChapterReviewDimensions } from "./chapter-review-dimensions";
export type {
  ArcPlanCheckDimension,
  ArcPlanValidationCheck,
  ChapterPlanCheckDimension,
  ChapterPlanValidationCheck,
  ChapterPlanValidationReport,
} from "./story-arc-review-policy";

export interface StoryArcBundle {
  arc: NarrativeArcPlan;
  batch: StoryArcBatchPlan;
  chapters: ChapterBlueprint[];
}

export interface StoryArcRebaseTargetChapter {
  chapterId: string;
  documentId: string;
  globalOrder: number;
  title: string;
  revisionId?: string;
  /**
   * A chapter with no revision is a forward plan, not committed history. Keep
   * the last approved blueprint as its execution contract during a rebase.
   */
  plannedBlueprint?: ChapterBlueprint;
  approvedPlan: {
    summary?: string;
    sceneEvents: string[];
    continuityConstraints: string[];
    setupRefs: string[];
    payoffRefs: string[];
    thematicMode?: ThemeTreatmentMode;
  };
  committedMemory?: {
    summary: string;
    keyEvents: string[];
    characterStates: Array<{ characterId: string; stateSnapshot: string }>;
    unresolvedThreads: string[];
    emotionalArc?: string;
  };
  authoritativeFacts: Array<{
    title: string;
    content: string;
    predicate?: string;
    subjectRefs: string[];
  }>;
}

export interface StoryArcRebaseTarget {
  arcId: string;
  executionStatus: ArcExecutionStatus;
  approvedArc: NarrativeArcPlan;
  batchIndex: number;
  startChapterIndex: number;
  chapters: StoryArcRebaseTargetChapter[];
}

export function validateStoryArcRebaseBundle(bundle: StoryArcBundle, target: StoryArcRebaseTarget): void {
  if (bundle.batch.batchIndex !== target.batchIndex || bundle.batch.startChapterIndex !== target.startChapterIndex) {
    throw new Error(`重基线结果必须保持原批次位置：batchIndex=${target.batchIndex}, startChapterIndex=${target.startChapterIndex}`);
  }
  if (bundle.chapters.length !== target.chapters.length) {
    throw new Error(`重基线结果必须逐章对应 ${target.chapters.length} 个已定稿文档，实际为 ${bundle.chapters.length} 章`);
  }
  if (target.executionStatus === "completed" && bundle.arc.expectedChapterCount !== target.chapters.length) {
    throw new Error(`已完成故事弧的 expectedChapterCount 必须保持为已定稿章节数 ${target.chapters.length}`);
  }
  if (target.executionStatus === "completed" && bundle.batch.complete !== true) {
    throw new Error("已完成故事弧的重基线批次必须标记 complete=true");
  }
  bundle.chapters.forEach((chapter, index) => {
    const targetChapter = target.chapters[index];
    if (chapter.thematicTreatment?.mode === "foreground" && target.chapters[index]?.approvedPlan.thematicMode !== "foreground") {
      throw new Error(`第 ${chapter.index} 章不得把缺少显式 foreground 契约的历史章节事后升级为 foreground`);
    }
    const expectedUnresolved = targetChapter?.committedMemory?.unresolvedThreads ?? targetChapter?.plannedBlueprint?.unresolvedAtClose;
    if (expectedUnresolved && JSON.stringify(chapter.unresolvedAtClose ?? []) !== JSON.stringify(expectedUnresolved)) {
      throw new Error(`第 ${chapter.index} 章的 unresolvedAtClose 必须保持冻结章节规划或已提交章节记忆中的未解边界`);
    }
    if (!targetChapter?.revisionId && !targetChapter?.committedMemory && !targetChapter?.plannedBlueprint) {
      throw new Error(`第 ${chapter.index} 章缺少已批准的未来蓝图，不能在重基线中凭空生成未创作章节`);
    }
    for (const scene of chapter.scenes) {
      for (const stake of scene.participantStakes ?? []) {
        if ((targetChapter?.revisionId || targetChapter?.committedMemory) && Object.values(stake.knowledgeBasis ?? {}).some((basis) => basis === "planned")) {
          throw new Error(`第 ${chapter.index} 章历史重基线的 participantStakes 不得把新规划当作人物动机依据`);
        }
      }
    }
  });
}

export function normalizeStoryArcRebaseBundle(bundle: StoryArcBundle, target: StoryArcRebaseTarget): StoryArcBundle {
  return {
    ...bundle,
    chapters: bundle.chapters.map((chapter, index) => {
      const targetChapter = target.chapters[index];
      const plannedBlueprint = !targetChapter?.revisionId && !targetChapter?.committedMemory
        ? targetChapter.plannedBlueprint
        : undefined;
      const candidate = plannedBlueprint
        ? { ...plannedBlueprint, index: chapter.index, narrativeScale: chapter.narrativeScale ?? plannedBlueprint.narrativeScale }
        : chapter;
      const normalized = candidate.thematicTreatment?.mode === "foreground" && targetChapter?.approvedPlan.thematicMode !== "foreground"
        ? {
        ...candidate,
        thematicTreatment: {
          mode: "absent" as const,
          questionRefs: [],
          carrier: "none" as const,
          evidenceChange: "",
          expositionBoundary: "",
        },
        }
        : candidate;
      const isHistoricalTarget = Boolean(targetChapter?.revisionId || targetChapter?.committedMemory);
      return {
        ...normalized,
        unresolvedAtClose: targetChapter?.committedMemory
          ? [...targetChapter.committedMemory.unresolvedThreads]
          : [...(plannedBlueprint?.unresolvedAtClose ?? normalized.unresolvedAtClose ?? [])],
        scenes: normalized.scenes.map((scene) => ({
          ...scene,
          participantStakes: scene.participantStakes?.map((stake) => {
            // Planned blueprints are the authority for future chapters. Only
            // strip speculative stake fields when rebasing committed history.
            if (!isHistoricalTarget) return stake;
            const basis = stake.knowledgeBasis;
            if (!basis) return stake;
            const want = basis.want === "unknown" || basis.want === "planned" ? "" : stake.want;
            const leverage = basis.leverage === "unknown" || basis.leverage === "planned" ? "" : stake.leverage;
            const withholding = basis.withholding === "unknown" || basis.withholding === "planned" ? "" : stake.withholding;
            const failureCost = basis.failureCost === "unknown" || basis.failureCost === "planned" ? "" : stake.failureCost;
            const normalizedBasis = { ...basis };
            if (basis.want === "planned") normalizedBasis.want = "unknown";
            if (basis.leverage === "planned") normalizedBasis.leverage = "unknown";
            if (basis.withholding === "planned") normalizedBasis.withholding = "unknown";
            if (basis.failureCost === "planned") normalizedBasis.failureCost = "unknown";
            if (basis.want !== "unknown" && !want.trim()) normalizedBasis.want = "unknown";
            if (basis.leverage !== "unknown" && !leverage.trim()) normalizedBasis.leverage = "unknown";
            if (basis.withholding !== "unknown" && !withholding.trim()) normalizedBasis.withholding = "unknown";
            if (basis.failureCost !== "unknown" && !failureCost.trim()) normalizedBasis.failureCost = "unknown";
            return { ...stake, want, leverage, withholding, failureCost, knowledgeBasis: normalizedBasis };
          }),
        })),
      };
    }),
  };
}

export function validateStoryArcExecutionContracts(bundle: StoryArcBundle): void {
  for (const chapter of bundle.chapters) {
    validateChapterExecutionContract(chapter);
  }
}

export function validateChapterExecutionContract(chapter: ChapterBlueprint): void {
    if (!chapter.narrativeFunction || !chapter.readerExperience?.trim() || !chapter.thematicTreatment || !chapter.stateTransition || !Array.isArray(chapter.unresolvedAtClose)) {
      throw new Error(`第 ${chapter.index} 章缺少新版叙事功能、读者体验、状态变化或主题显隐契约`);
    }
    if (!Array.isArray(chapter.worldRuleRefs) || !Array.isArray(chapter.characterFocus) || !chapter.romanceTreatment || !chapter.humorTreatment) {
      throw new Error(`第 ${chapter.index} 章缺少世界规则、群像焦点、感情线或幽默处理契约`);
    }
    for (const focus of chapter.characterFocus) {
      if ([focus.characterRef, focus.function, focus.desire, focus.action, focus.cost].some((value) => !value.trim())) {
        throw new Error(`第 ${chapter.index} 章的 characterFocus 必须包含人物、功能、欲望、行动和代价`);
      }
    }
    if (chapter.romanceTreatment.status === "active" && [chapter.romanceTreatment.stage, chapter.romanceTreatment.actionEvidence].some((value) => !value.trim())) {
      throw new Error(`第 ${chapter.index} 章的 active 感情线必须包含阶段和行动证据`);
    }
    if (chapter.humorTreatment.status === "active" && [chapter.humorTreatment.opportunity, chapter.humorTreatment.evidence].some((value) => !value.trim())) {
      throw new Error(`第 ${chapter.index} 章的 active 幽默必须包含机会和情境证据`);
    }
    if (!chapter.romanceTreatment.boundary.trim()) throw new Error(`第 ${chapter.index} 章的感情线适用性必须包含边界或不适用理由`);
    if (!chapter.humorTreatment.boundary.trim()) throw new Error(`第 ${chapter.index} 章的幽默适用性必须包含边界或不适用理由`);
    if (chapter.narrativeScale) {
      if (!chapter.narrativeScale.reason.trim() || !chapter.narrativeScale.developmentAxes.length || !chapter.narrativeScale.stoppingCondition.trim()) {
        throw new Error(`第 ${chapter.index} 章的 narrativeScale 必须包含规模理由、展开轴和收束条件`);
      }
    }
    if ([chapter.stateTransition.before, chapter.stateTransition.after, chapter.stateTransition.evidence].some((value) => !value.trim())) throw new Error(`第 ${chapter.index} 章的 stateTransition 不完整`);
    const treatment = chapter.thematicTreatment;
    if (treatment.mode === "absent" && (treatment.carrier !== "none" || treatment.questionRefs.length > 0 || treatment.evidenceChange.trim())) {
      throw new Error(`第 ${chapter.index} 章的 absent 主题模式不得引用主题问题、承载方式或证据变化`);
    }
    if (treatment.mode === "subtext" && (treatment.carrier === "none" || treatment.carrier === "dialogue-conflict")) {
      throw new Error(`第 ${chapter.index} 章的 subtext 主题必须由行动、关系、世界反应或后果承载`);
    }
    if (treatment.mode === "foreground" && treatment.carrier !== "dialogue-conflict") {
      throw new Error(`第 ${chapter.index} 章的 foreground 主题必须由具体处境中的 dialogue-conflict 承载`);
    }
    if (treatment.mode !== "absent" && (!treatment.questionRefs.length || !treatment.evidenceChange.trim() || !treatment.expositionBoundary.trim())) {
      throw new Error(`第 ${chapter.index} 章的主题处理缺少问题引用、证据变化或解释边界`);
    }
    if (!chapter.scenes.length) throw new Error(`第 ${chapter.index} 章至少需要一个可执行场景`);
    chapter.scenes.forEach((scene, sceneIndex) => {
      const required = [scene.goal, scene.opposition, scene.turn, scene.outcome, scene.cost];
      if (required.some((value) => !value?.trim())) throw new Error(`第 ${chapter.index} 章场景 ${sceneIndex + 1} 缺少 goal/opposition/turn/outcome/cost 执行链`);
      const stakes = scene.participantStakes ?? [];
      const minimumStakeCount = scene.participants.length > 1 ? 2 : 1;
      if (stakes.length < minimumStakeCount) throw new Error(`第 ${chapter.index} 章场景 ${sceneIndex + 1} 缺少多方 participantStakes`);
      for (const stake of stakes) {
        const basis = stake.knowledgeBasis;
        const values = { want: stake.want, leverage: stake.leverage, withholding: stake.withholding, failureCost: stake.failureCost };
        if (!scene.participants.includes(stake.participant) || !basis) {
          throw new Error(`第 ${chapter.index} 章场景 ${sceneIndex + 1} 的 participantStakes 不完整或与参与者不一致`);
        }
        for (const field of Object.keys(values) as Array<keyof typeof values>) {
          if (!STAKE_KNOWLEDGE_BASES.includes(basis[field]) || (basis[field] === "unknown" ? values[field].trim() : !values[field].trim())) {
            throw new Error(`第 ${chapter.index} 章场景 ${sceneIndex + 1} 的 ${stake.participant}.${field} 内容与 knowledgeBasis 不一致`);
          }
        }
      }
    });
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
  neighbors: Array<Pick<ChapterBlueprintRecord, "id" | "globalOrder" | "title" | "summary" | "chapterPurpose" | "narrativeFunction" | "readerExperience" | "thematicTreatment"> & Partial<Pick<ChapterBlueprintRecord, "worldRuleRefs" | "characterFocus" | "romanceTreatment" | "humorTreatment">>>;
  sourceArtifactIds: string[];
  fingerprint: string;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

export function parseChapterNarrativeScale(value: unknown): ChapterBlueprint["narrativeScale"] {
  if (value === undefined || value === null) return defaultChapterNarrativeScale();
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const level = enumValue(item.level, CHAPTER_NARRATIVE_SCALE_LEVELS);
  const reason = typeof item.reason === "string" ? item.reason.trim() : "";
  const developmentAxes = strings(item.developmentAxes).map((axis) => axis.trim()).filter(Boolean);
  const stoppingCondition = typeof item.stoppingCondition === "string" ? item.stoppingCondition.trim() : "";
  if (!level || !reason || !developmentAxes.length || !stoppingCondition) return undefined;
  return { level, reason, developmentAxes, stoppingCondition };
}

function parseThematicTreatment(value: unknown): ThematicTreatment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const mode = enumValue(item.mode, THEME_TREATMENT_MODES);
  const carrier = enumValue(item.carrier, THEME_CARRIERS);
  if (!mode || !carrier) return undefined;
  return {
    mode,
    questionRefs: strings(item.questionRefs),
    carrier,
    evidenceChange: typeof item.evidenceChange === "string" ? item.evidenceChange : "",
    expositionBoundary: typeof item.expositionBoundary === "string" ? item.expositionBoundary : "",
  };
}

function parseApplicability(value: unknown): PlanApplicability {
  return enumValue(value, PLAN_APPLICABILITY) ?? "not-applicable";
}

function parseRomanceTreatment(value: unknown): RomanceTreatment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "not-applicable", stage: "", actionEvidence: "", boundary: "本章不承担感情线推进" };
  }
  const item = value as Record<string, unknown>;
  return {
    status: parseApplicability(item.status),
    stage: typeof item.stage === "string" ? item.stage : "",
    actionEvidence: typeof item.actionEvidence === "string" ? item.actionEvidence : "",
    boundary: typeof item.boundary === "string" ? item.boundary : "",
  };
}

function parseHumorTreatment(value: unknown): HumorTreatment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "not-applicable", opportunity: "", evidence: "", boundary: "本章不强制加入幽默" };
  }
  const item = value as Record<string, unknown>;
  return {
    status: parseApplicability(item.status),
    opportunity: typeof item.opportunity === "string" ? item.opportunity : "",
    evidence: typeof item.evidence === "string" ? item.evidence : "",
    boundary: typeof item.boundary === "string" ? item.boundary : "",
  };
}

function parseCharacterFocus(value: unknown): CharacterFocus[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.characterRef !== "string") return [];
    return [{
      characterRef: item.characterRef,
      function: typeof item.function === "string" ? item.function : "",
      desire: typeof item.desire === "string" ? item.desire : "",
      action: typeof item.action === "string" ? item.action : "",
      cost: typeof item.cost === "string" ? item.cost : "",
    }];
  });
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
    const rawStateTransition = chapter.stateTransition && typeof chapter.stateTransition === "object" && !Array.isArray(chapter.stateTransition)
      ? chapter.stateTransition as Record<string, unknown>
      : undefined;
    const stateTransition = rawStateTransition && typeof rawStateTransition.before === "string" && typeof rawStateTransition.after === "string" && typeof rawStateTransition.evidence === "string"
      ? { before: rawStateTransition.before, after: rawStateTransition.after, evidence: rawStateTransition.evidence }
      : undefined;
    return {
      id: typeof chapter.id === "string" ? chapter.id : undefined,
      index: offset + 1,
      title: chapterTitle,
      summary,
      chapterPurpose: stateTransition
        ? `从“${stateTransition.before}”变为“${stateTransition.after}”；可观察证据：${stateTransition.evidence}`
        : typeof chapter.chapterPurpose === "string" ? chapter.chapterPurpose : "",
      stateTransition,
      narrativeFunction: enumValue(chapter.narrativeFunction, CHAPTER_NARRATIVE_FUNCTIONS),
      readerExperience: typeof chapter.readerExperience === "string" && chapter.readerExperience.trim() ? chapter.readerExperience : undefined,
      thematicTreatment: parseThematicTreatment(chapter.thematicTreatment),
      worldRuleRefs: strings(chapter.worldRuleRefs),
      characterFocus: parseCharacterFocus(chapter.characterFocus),
      romanceTreatment: parseRomanceTreatment(chapter.romanceTreatment),
      humorTreatment: parseHumorTreatment(chapter.humorTreatment),
      dramaticQuestion: typeof chapter.dramaticQuestion === "string" ? chapter.dramaticQuestion : "",
      povCharacterId: typeof chapter.povCharacterId === "string" && chapter.povCharacterId.trim() ? chapter.povCharacterId : undefined,
      emotionalMovement: typeof chapter.emotionalMovement === "string" ? chapter.emotionalMovement : "",
      stateDeltaBudget: typeof chapter.stateDeltaBudget === "string" ? chapter.stateDeltaBudget : "",
      narrativeScale: parseChapterNarrativeScale(chapter.narrativeScale),
      optionalBeats: strings(chapter.optionalBeats),
      scenes: rawScenes.map((scene, sceneIndex) => {
        const item = scene && typeof scene === "object" && !Array.isArray(scene) ? scene as Record<string, unknown> : {};
        return {
          title: typeof item.title === "string" ? item.title : `场景 ${sceneIndex + 1}`,
          summary: typeof item.summary === "string" ? item.summary : "",
          goal: typeof item.goal === "string" ? item.goal : undefined,
          opposition: typeof item.opposition === "string" ? item.opposition : undefined,
          participants: strings(item.participants),
          turn: typeof item.turn === "string" ? item.turn : undefined,
          outcome: typeof item.outcome === "string" ? item.outcome : undefined,
          cost: typeof item.cost === "string" ? item.cost : undefined,
          participantStakes: Array.isArray(item.participantStakes) ? item.participantStakes.flatMap((stake) => {
            if (!stake || typeof stake !== "object" || Array.isArray(stake)) return [];
            const value = stake as Record<string, unknown>;
            if (typeof value.participant !== "string") return [];
            const rawBasis = value.knowledgeBasis && typeof value.knowledgeBasis === "object" && !Array.isArray(value.knowledgeBasis)
              ? value.knowledgeBasis as Record<string, unknown>
              : undefined;
            const knowledgeBasis = rawBasis
              ? {
                want: enumValue(rawBasis.want, STAKE_KNOWLEDGE_BASES),
                leverage: enumValue(rawBasis.leverage, STAKE_KNOWLEDGE_BASES),
                withholding: enumValue(rawBasis.withholding, STAKE_KNOWLEDGE_BASES),
                failureCost: enumValue(rawBasis.failureCost, STAKE_KNOWLEDGE_BASES),
              }
              : undefined;
            return [{
              participant: value.participant,
              want: typeof value.want === "string" ? value.want : "",
              leverage: typeof value.leverage === "string" ? value.leverage : "",
              withholding: typeof value.withholding === "string" ? value.withholding : "",
              failureCost: typeof value.failureCost === "string" ? value.failureCost : "",
              knowledgeBasis: knowledgeBasis && Object.values(knowledgeBasis).every(Boolean)
                ? knowledgeBasis as NonNullable<NonNullable<ChapterSceneBlueprint["participantStakes"]>[number]["knowledgeBasis"]>
                : undefined,
            }];
          }) : undefined,
        };
      }),
      continuityConstraints: strings(chapter.continuityConstraints),
      setupRefs: strings(chapter.setupRefs),
      payoffRefs: strings(chapter.payoffRefs),
      unresolvedAtClose: Array.isArray(chapter.unresolvedAtClose) ? strings(chapter.unresolvedAtClose) : undefined,
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
      thematicQuestions: Array.isArray(arcValue.thematicQuestions) ? arcValue.thematicQuestions.map((question) => {
        const item = question && typeof question === "object" && !Array.isArray(question) ? question as Record<string, unknown> : {};
        return {
          id: String(item.id ?? "").trim(),
          question: String(item.question ?? "").trim(),
          opposingPressures: String(item.opposingPressures ?? "").trim(),
          resolutionWindow: String(item.resolutionWindow ?? "").trim(),
        };
      }).filter((question) => question.id && question.question) : [],
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

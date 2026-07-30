import { createHash } from "node:crypto";
import { PROJECT_PLAN_STAGES, type ProjectPlanSection } from "./project-plan";

export interface BookSynopsisRecord {
  text: string;
  generatedAt: string;
  sourceFingerprint: string;
}

export interface BookTitleCandidate {
  title: string;
  rationale: string;
}

export interface BookTitleCandidatesRecord {
  candidates: BookTitleCandidate[];
  generatedAt: string;
  sourceFingerprint: string;
  selectedTitle?: string;
}

export const BOOK_TITLE_CANDIDATES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      minItems: 4,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "rationale"],
        properties: {
          title: { type: "string", minLength: 2, maxLength: 30 },
          rationale: { type: "string", minLength: 8, maxLength: 160 },
        },
      },
    },
  },
} as const;

export const BOOK_SYNOPSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["synopsis"],
  properties: {
    synopsis: {
      type: "string",
      minLength: 120,
      maxLength: 900,
      description: "面向潜在读者的中文作品简介",
    },
  },
} as const;

export function approvedPlanSections(sections: readonly ProjectPlanSection[]): ProjectPlanSection[] {
  const byKey = new Map(sections.map((section) => [section.taskKey, section]));
  return PROJECT_PLAN_STAGES.flatMap((stage) => {
    const section = byKey.get(stage.taskKey);
    return section?.status === "approved" && section.sourceArtifactId ? [section] : [];
  });
}

export function missingSynopsisPlanStages(sections: readonly ProjectPlanSection[]): string[] {
  const approved = new Set(approvedPlanSections(sections).map((section) => section.taskKey));
  return PROJECT_PLAN_STAGES.filter((stage) => !approved.has(stage.taskKey)).map((stage) => stage.label);
}

export function bookSynopsisSourceFingerprint(input: { projectTitle: string; sections: readonly ProjectPlanSection[] }): string {
  const source = approvedPlanSections(input.sections)
    .map((section) => `${section.taskKey}:${section.sourceArtifactId}:${section.editRevision}`)
    .join("\n");
  return createHash("sha256").update(`${input.projectTitle.trim()}\n${source}`).digest("hex");
}

export function bookTitleSourceFingerprint(sections: readonly ProjectPlanSection[]): string {
  const source = approvedPlanSections(sections)
    .map((section) => `${section.taskKey}:${section.sourceArtifactId}:${section.editRevision}`)
    .join("\n");
  return createHash("sha256").update(source).digest("hex");
}

export function buildBookTitleCandidatesPrompt(sections: readonly ProjectPlanSection[]): string {
  const missing = missingSynopsisPlanStages(sections);
  if (missing.length) throw new Error(`全书规划尚未全部确认：${missing.join("、")}`);
  const plan = approvedPlanSections(sections).map((section) => ({
    taskKey: section.taskKey,
    label: PROJECT_PLAN_STAGES.find((stage) => stage.taskKey === section.taskKey)?.label ?? section.taskKey,
    content: section.payload,
  }));
  return [
    "任务：根据下方已经确认的完整全书规划，提出 4-6 个有辨识度、易记且能吸引目标读者的中文书名候选。",
    "命名原则：优先凝练作品最独特的意象、矛盾、人物命运或叙事承诺；候选之间应采用不同命名角度，而不是近义词替换。",
    "边界：忠实于规划事实，不泄露结局或关键反转，不使用项目 ID、日期、版本号、通用占位词，不模仿规划外的具体作品名称。",
    "体裁适配：字数、节奏和语感服从作品题材与目标读者，不把固定网文句式、四字格或诗性表达当成统一标准。",
    "输出：每个候选包含 title 与 rationale；title 不带书名号，rationale 用一句话说明它如何承载本作的阅读承诺。",
    "全书规划（一次性完整输入）：",
    JSON.stringify(plan, null, 2),
  ].join("\n\n");
}

export function normalizeBookTitleCandidates(value: unknown): BookTitleCandidate[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型没有返回有效的书名候选");
  const raw = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw)) throw new Error("模型没有返回有效的书名候选");
  const seen = new Set<string>();
  const candidates = raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim().replace(/^《|》$/g, "") : "";
    const rationale = typeof record.rationale === "string" ? record.rationale.trim() : "";
    if (!title || title.length > 30 || !/[\u3400-\u9fff]/u.test(title) || !rationale || seen.has(title)) return [];
    seen.add(title);
    return [{ title, rationale }];
  });
  if (candidates.length < 2) throw new Error("模型返回的有效中文书名候选不足");
  return candidates.slice(0, 6);
}

export function buildBookSynopsisPrompt(input: { projectTitle: string; sections: readonly ProjectPlanSection[] }): string {
  const missing = missingSynopsisPlanStages(input.sections);
  if (missing.length) throw new Error(`全书规划尚未全部确认：${missing.join("、")}`);

  const plan = approvedPlanSections(input.sections).map((section) => ({
    taskKey: section.taskKey,
    label: PROJECT_PLAN_STAGES.find((stage) => stage.taskKey === section.taskKey)?.label ?? section.taskKey,
    content: section.payload,
  }));

  return [
    `作品名称：${input.projectTitle}`,
    "任务：根据下方已经确认的完整全书规划，写一段能够吸引目标读者继续阅读的中文作品简介。",
    "写作原则：提炼主角处境、核心冲突、关键风险与本作最有辨识度的阅读承诺；用具体、有画面感的语言建立悬念和情绪张力。",
    "边界：面向读者而非作者，不出现规划、阶段、设定表等幕后术语；不要罗列剧情，不泄露结局或关键反转，不添加规划中没有依据的人物、规则或事件。",
    "体裁适配：语气、节奏与信息密度应服从作品题材和目标读者，不套用固定网文模板、固定人称或固定句式。",
    "长度：约 250-500 个中文字符，形成连贯完整的简介，不加标题、标签、解释或创作过程。",
    "全书规划（一次性完整输入）：",
    JSON.stringify(plan, null, 2),
  ].join("\n\n");
}

export function parseBookSynopsisMetadata(metadata: Record<string, unknown>): BookSynopsisRecord | undefined {
  const value = metadata.bookSynopsis;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string" || !record.text.trim()) return undefined;
  if (typeof record.generatedAt !== "string" || typeof record.sourceFingerprint !== "string") return undefined;
  return { text: record.text.trim(), generatedAt: record.generatedAt, sourceFingerprint: record.sourceFingerprint };
}

export function parseBookTitleCandidatesMetadata(metadata: Record<string, unknown>): BookTitleCandidatesRecord | undefined {
  const value = metadata.bookTitleCandidates;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.generatedAt !== "string" || typeof record.sourceFingerprint !== "string") return undefined;
  try {
    const candidates = normalizeBookTitleCandidates({ candidates: record.candidates });
    return {
      candidates,
      generatedAt: record.generatedAt,
      sourceFingerprint: record.sourceFingerprint,
      selectedTitle: typeof record.selectedTitle === "string" ? record.selectedTitle : undefined,
    };
  } catch {
    return undefined;
  }
}

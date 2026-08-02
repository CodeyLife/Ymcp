export const CREATIVE_BRIEF_VERSION = 1 as const;

export interface CreativeBriefNotApplicable {
  notApplicable: true;
  rationale: string;
}

export type CreativeBriefText = string | CreativeBriefNotApplicable;

export interface CreativeBriefSeed {
  version: typeof CREATIVE_BRIEF_VERSION;
  targetReader?: string;
  corePromise?: string;
  themeQuestion?: CreativeBriefText;
  protagonistNeed?: string;
  protagonistContradiction?: string;
  centralOpposition?: string;
  emotionalContract?: CreativeBriefText;
  worldAnchor?: string;
  researchNeeds?: string[];
  nonNegotiables?: string[];
  endingEnvelope?: string;
  stylePreferences?: string;
}

const TEXT_FIELDS = [
  "targetReader",
  "corePromise",
  "protagonistNeed",
  "protagonistContradiction",
  "centralOpposition",
  "worldAnchor",
  "endingEnvelope",
  "stylePreferences",
] as const;

const ANNOTATED_TEXT_FIELDS = ["themeQuestion", "emotionalContract"] as const;

const LIST_FIELDS = ["researchNeeds", "nonNegotiables"] as const;

function text(value: unknown, field?: string): string | undefined {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error(`creativeBrief.${field ?? "field"} 必须是字符串`);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function list(value: unknown, field: string): string[] | undefined {
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    throw new Error(`creativeBrief.${field} 必须是字符串数组`);
  }
  if (!Array.isArray(value)) return undefined;
  if (value.some((item) => typeof item !== "string")) throw new Error(`creativeBrief.${field} 必须是字符串数组`);
  const values = value.map((item) => item.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

function annotatedText(value: unknown, field: string): CreativeBriefText | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return text(value, field);
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`creativeBrief.${field} 必须是字符串或不适用标记`);
  const record = value as Record<string, unknown>;
  const rationale = text(record.rationale, `${field}.rationale`);
  if (record.notApplicable !== true || !rationale) {
    throw new Error(`creativeBrief.${field} 的不适用标记必须包含 notApplicable=true 和 rationale`);
  }
  return { notApplicable: true, rationale };
}

/**
 * Normalize the optional creation brief at the shared API boundary.
 * Unknown keys are ignored so older clients can safely send forward-compatible metadata.
 */
export function parseCreativeBrief(value: unknown): CreativeBriefSeed | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("creativeBrief 必须是对象");
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && record.version !== CREATIVE_BRIEF_VERSION) {
    throw new Error(`creativeBrief.version 仅支持 ${CREATIVE_BRIEF_VERSION}`);
  }
  const result: CreativeBriefSeed = { version: CREATIVE_BRIEF_VERSION };
  for (const field of TEXT_FIELDS) {
    const value = text(record[field], field);
    if (value) result[field] = value;
  }
  for (const field of ANNOTATED_TEXT_FIELDS) {
    const value = annotatedText(record[field], field);
    if (value) result[field] = value;
  }
  for (const field of LIST_FIELDS) {
    const value = list(record[field], field);
    if (value) result[field] = value;
  }
  return Object.keys(result).length > 1 ? result : undefined;
}

export function creativeBriefPrompt(brief: CreativeBriefSeed | undefined): string {
  if (!brief) return "- 未提供额外创作简报；请从 premise 推导，并把关键未知项标记为待作者确认。";
  const render = (label: string, value: CreativeBriefText | undefined): string | undefined => {
    if (!value) return undefined;
    return typeof value === "string" ? `- ${label}：${value}` : `- ${label}：不适用；理由：${value.rationale}`;
  };
  const lines = [
    `- 简报版本：${brief.version}`,
    brief.targetReader && `- 目标读者：${brief.targetReader}`,
    brief.corePromise && `- 核心叙事承诺：${brief.corePromise}`,
    render("主题问题", brief.themeQuestion),
    brief.protagonistNeed && `- 主角核心需要：${brief.protagonistNeed}`,
    brief.protagonistContradiction && `- 主角核心矛盾：${brief.protagonistContradiction}`,
    brief.centralOpposition && `- 中央对抗：${brief.centralOpposition}`,
    render("情感契约", brief.emotionalContract),
    brief.worldAnchor && `- 世界锚点：${brief.worldAnchor}`,
    brief.researchNeeds?.length && `- 研究需求：${brief.researchNeeds.join("；")}`,
    brief.nonNegotiables?.length && `- 不可违背项：${brief.nonNegotiables.join("；")}`,
    brief.endingEnvelope && `- 结局边界：${brief.endingEnvelope}`,
    brief.stylePreferences && `- 风格偏好：${brief.stylePreferences}`,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n") : "- 未提供额外创作简报；请从 premise 推导，并把关键未知项标记为待作者确认。";
}

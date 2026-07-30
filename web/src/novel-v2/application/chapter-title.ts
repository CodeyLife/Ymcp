import { createHash } from "node:crypto";

export interface ChapterTitleSource {
  projectTitle: string;
  documentId: string;
  currentTitle: string;
  narrativeOrder: number;
  chapterGoal: string;
  blueprint: Record<string, unknown>;
  blueprintFingerprint: string;
  contentHash?: string;
  plainText?: string;
}

export const CHAPTER_TITLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: {
      type: "string",
      minLength: 2,
      maxLength: 16,
      description: "与本章独特内容相符的中文章节名，不带序号或书名号",
    },
  },
} as const;

export function chapterTitleSourceFingerprint(source: Omit<ChapterTitleSource, "plainText" | "blueprint">): string {
  return createHash("sha256").update(JSON.stringify({
    projectTitle: source.projectTitle.trim(),
    documentId: source.documentId,
    currentTitle: source.currentTitle.trim(),
    narrativeOrder: source.narrativeOrder,
    chapterGoal: source.chapterGoal.trim(),
    blueprintFingerprint: source.blueprintFingerprint,
    contentHash: source.contentHash ?? "",
  })).digest("hex");
}

export function buildChapterTitlePrompt(source: ChapterTitleSource): string {
  return [
    `作品书名：${source.projectTitle}`,
    `章节序号：${source.narrativeOrder}`,
    `当前章节名：${source.currentTitle}`,
    "任务：根据本章目标、章节蓝图与已有正文，为本章重新拟定一个准确、有辨识度的中文章节名。",
    "命名决策：优先采用四个汉字；若四字会损害准确性、独特性或语言自然度，可使用 2-8 个汉字。内容贴合度高于机械凑成四字。",
    "边界：标题应抓住本章最独特的行动、意象、转折或情绪，不泄露后续剧情；避免“风云再起”“暗流涌动”等可套用于任意章节的泛化词组。",
    "格式：只返回 title 字段；不带“第几章”、书名号、引号、冒号、解释或备选项。",
    `章节目标：${source.chapterGoal || "未单独填写，以蓝图与正文为准"}`,
    "章节蓝图：",
    JSON.stringify(source.blueprint, null, 2),
    "当前正文：",
    source.plainText?.trim() || "尚无正文，以章节目标与蓝图命名",
  ].join("\n\n");
}

export function normalizeChapterTitle(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型没有返回有效的章节名");
  const raw = (value as { title?: unknown }).title;
  if (typeof raw !== "string") throw new Error("模型没有返回有效的章节名");
  const title = raw.trim()
    .replace(/^第[零一二三四五六七八九十百千万两\d]+章[：:\s]*/u, "")
    .replace(/^[《「『“"']+|[》」』”"']+$/gu, "")
    .trim();
  if (title.length < 2 || title.length > 16 || !/[\u3400-\u9fff]/u.test(title)) throw new Error("模型返回的章节名不是有效中文标题");
  return title;
}

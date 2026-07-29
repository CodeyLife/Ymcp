import type { Artifact } from "../protocol";
import { chapterMemorySchema, type ChapterMemoryOutput } from "../prompts/schemas";

/**
 * V2 章节记忆提取 prompt 构造器。
 *
 * 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约。
 * 与 fact-extraction 互补：fact 提取细粒度事实（subject/predicate/object），
 * chapter memory 提取章节级高层摘要（summary/keyEvents/characterStates/...），
 * 用于长篇跨章节一致性（前 N 章 summary 召回 + 角色状态快照 + 未解决线索追踪）。
 *
 * 设计原则（AGENTS.md「reusable contracts over case-specific examples」）：
 * - prompt 只描述通用提取规则，不嵌入任何题材/类型/角色名 fixture
 * - 不内置网文爽点/套路识别（走 craft rule 沉淀）
 * - 提取目标是题材无关的叙事要素：事件、角色状态、未解线索、情绪弧光
 */

export interface ChapterMemoryPromptInput {
  artifact: Artifact;
  text: string;
  /** 已存在的前章 chapter memory 摘要（用于让 LLM 理解上下文连续性，避免重复提取）。 */
  priorChapterDigest?: string;
}

/**
 * 构建章节记忆提取 prompt。
 */
export function buildChapterMemoryPrompt(input: ChapterMemoryPromptInput): string {
  return [
    `从下面章节正文中提取结构化的「章节记忆」，用于长篇跨章节一致性。`,
    "",
    `## 提取目标`,
    `章节记忆是章节级的高层摘要，让后续章节生成时能快速召回"前章发生了什么"而不必重新检索所有细粒度事实。`,
    "",
    `## 字段说明`,
    `- summary：本章核心进展的自然语言摘要（200-400 字）。要求：覆盖本章主要事件、角色关系变化、情节推进，避免堆砌细节；不直接复制正文原文。`,
    `- keyEvents：本章关键事件列表（按出现顺序，3-15 条）。每条 1-2 句话描述一个独立事件，要求：动作者 + 行为 + 后果（如"林明在密室中发现古老卷轴，触发守护者苏醒"）。`,
    `- characterStates：本章结束时各主要角色的处境快照。characterId 用正文中的角色名（如"林明"），stateSnapshot 描述该角色在本章结束时的位置、情绪、能力、知识状态等。只列本章有戏份的角色（2-6 个）。`,
    `- unresolvedThreads：本章埋设或仍悬置的线索/伏笔/未解之谜（0-8 条）。包括：新埋的伏笔（如"卷轴上的符文含义未明"）、仍未解决的旧线索（如"师父下落仍未查明"）。`,
    `- emotionalArc：本章情绪弧光简述（1 句话，如"从紧张对峙到短暂和解，结尾留下疑虑"）。用于追踪全书节奏曲线。`,
    "",
    `## 提取规则`,
    `- 只提取正文实际呈现的内容，不提取隐喻、修辞、读者推断、作者意图。`,
    `- characterStates 中的 characterId 必须是正文中可指认的角色名，不用"主角""反派"等代词。`,
    `- keyEvents 按正文出现顺序排列，不按重要性重排。`,
    `- unresolvedThreads 只列"未解决"的线索，已在本章兑现的伏笔不算。`,
    `- 如果本章无角色戏份（如纯景物描写），characterStates 可以为空数组。`,
    `- 如果本章无未解线索，unresolvedThreads 可以为空数组。`,
    "",
    `## 已存在的前章摘要（仅供理解上下文，不要重复）`,
    input.priorChapterDigest ?? "- 暂无前章摘要，本章为开篇或独立章节。",
    "",
    `## 章节正文（段落编号仅用于定位）`,
    buildNumberedText(input.text),
    "",
    `## 章节元数据`,
    `- artifactId: ${input.artifact.id}`,
    `- kind: ${input.artifact.kind}`,
    `- baseRevision: ${input.artifact.baseRevision}`,
    `- createdAt: ${new Date(input.artifact.createdAt).toISOString()}`,
  ].join("\n");
}

function buildNumberedText(text: string): string {
  const paragraphs = text.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  return paragraphs.map((paragraph, index) => `### 段落 ${index + 1}\n${paragraph}`).join("\n\n");
}

export { chapterMemorySchema, type ChapterMemoryOutput };

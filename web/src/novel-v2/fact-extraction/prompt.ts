import type { Artifact } from "../protocol";
import { factExtractionSchema, type FactExtractionOutput } from "../prompts/schemas";

/**
 * V2 事实提取 prompt 构造器。
 *
 * 与 v1 [facts.ts] 的 LLM 提取 prompt 等价，但参数化为 v2 数据结构。
 *
 * 提取目标：从章节正文中识别结构化事实（subject/predicate/object + 元数据），
 * 用于：
 * - 写入 memory_claims 表（v2 替代 v1 factAssertions/knowledgeAssertions）
 * - 在 qdrant-memory 中建立语义索引供后续检索
 * - 检测与既有 MemoryBundle 的冲突（conflict=true）
 */

export interface FactExtractionPromptInput {
  artifact: Artifact;
  text: string;
  existingClaimsDigest?: string;
  /**
   * 可选,激活的 skill bundle(注入 promptSections["fact-extraction"])。
   *
   * 设计依据:让 v1 迁移的 fact-delta-extraction skill 的 promptSections
   * 真正进入 LLM,而非死载荷。对齐 foundation/draft/review/revise 的 skill 注入方式。
   */
  skills?: Array<{ skillId: string; promptSections: Partial<Record<string, string>> }>;
}

/**
 * 构建事实提取 prompt。
 *
 * 设计依据：AGENTS.md「root-cause analysis」要求 reusable contracts over
 * case-specific examples。本 prompt 只描述通用提取规则，不嵌入任何 fixture。
 *
 * Skill 注入:取 skill.promptSections["fact-extraction"] 文本注入到
 * "## 激活技能（事实提取指导）" 段,让 fact-delta-extraction 等迁移 skill 生效。
 */
export function buildFactExtractionPrompt(input: FactExtractionPromptInput): string {
  const sections: string[] = [
    `从下面章节正文中提取结构化事实与叙事元素。只提取正文实际呈现的内容，不提取隐喻、修辞或读者推断。`,
    "",
  ];

  // Skill 注入(对齐 chapter-draft.ts / foundation.ts 的注入方式)
  if (input.skills?.length) {
    sections.push("## 激活技能（事实提取指导）");
    for (const skill of input.skills) {
      const sectionText = skill.promptSections["fact-extraction"] ?? "";
      if (!sectionText) continue;
      sections.push(`### ${skill.skillId}`);
      sections.push(sectionText);
      sections.push("");
    }
  }

  sections.push(
    `## 提取规则（facts）`,
    `- subject.kind 限定为：project/entity/relation/outline/scene/thread/foreshadowing/timeline。`,
    `- subject.id 必须是正文中可指认的对象（人物名、地点名、关系名等）；不得用"主角""反派"等代词。`,
    `- predicate 是事实陈述的谓词，如"出生于""持有""与X约定""位于"。`,
    `- object.kind 限定为：entity-ref/string/number/boolean/json。entity-ref 时 value 必须是另一主体的 id。`,
    `- polarity=affirmed 表示正面陈述；negated 表示正文明确否定（如"并未出生于此"）。`,
    `- truthStatus：objective=客观事实（地点、时间、物件状态）；claim=人物声明（可能不可靠）；contested=多方冲突陈述；open-question=正文留白。`,
    `- humanReadable 是事实的自然语言描述，便于人工审核。`,
    `- evidence 必须引用正文逐字证据（不少于 8 字），不得概括。`,
    `- paragraph 是证据所在段落号（从 1 开始）。`,
    `- confidence 0-1：直接陈述=0.9+，转述=0.7+，暗示=0.5+；低于 0.5 不提取。`,
    `- novelty=new/update/duplicate：相对于已存在记忆的新增/更新/重复。`,
    `- conflict=true：与既有冻结记忆冲突（需要后续人工审核）。`,
    "",
    `## 提取规则（narrativeElements，Phase 3.1）`,
    `除了 facts，还要提取本章的叙事装置：伏笔、承诺、兑现。`,
    "",
    `### foreshadowings（本章埋设的伏笔）`,
    `- 只提取正文实际暗示但未明确揭示的内容（如"她注意到墙上那幅画似乎在动"）。`,
    `- triggerKeywords 是后续兑现时应出现的关键词（如"画""动""隐藏"）。`,
    `- expectedPayoffWindow 是预期兑现时机（如"5 章内""本卷末""长篇后期"）。`,
    `- 不提取：明显的剧情推进、角色内心独白、修辞意象。`,
    "",
    `### promises（本章作出的承诺）`,
    `- 只提取正文明确陈述的承诺（如"我一定会回来""三个月后还你"）。`,
    `- promiser/promisee 必须是正文中可指认的角色名（不用"主角""他"）。`,
    `- statement 是承诺的自然语言描述。`,
    "",
    `### payoffs（本章兑现的伏笔/承诺）`,
    `- 只提取本章实际兑现的内容，不提取"即将兑现"的暗示。`,
    `- payoffType=foreshadowing：兑现了之前的伏笔；matchedTriggerKeywords 填匹配到的伏笔触发关键词。`,
    `- payoffType=promise：兑现了之前的承诺；matchedPromiser 填承诺者角色名。`,
    `- intensity 1-5：1=轻描淡写，3=明显推进，5=高潮爆发。`,
    "",
    `## 提取规则（payoffMoments，Phase 3.2）`,
    `除了 facts 和 narrativeElements，还要提取本章的"爽点时刻"——读者获得正向反馈的关键瞬间。`,
    `爽点是通用爽感维度，不依赖金手指/系统流特化，任何题材都可能有爽点。`,
    "",
    `### 爽点类型（payoffType）`,
    `- achievement：成就型——突破、获得、达成目标（如练成绝招、获得宝物、通过考验）。`,
    `- recognition：认可型——被肯定、被敬畏、地位提升（如被长辈夸奖、被敌人忌惮、身份揭露后众人震惊）。`,
    `- reversal：反转型——逆境翻盘、真相揭露、打脸（如被低估后展现实力、被冤枉后真相大白）。`,
    `- emotional：情感型——羁绊深化、虐心释放、温情时刻（如误会化解、生死相托、久别重逢）。`,
    `- mystery：悬疑型——谜团揭开、伏笔兑现、真相浮现（如密室手法曝光、历史真相揭开、幕后黑手现身）。`,
    "",
    `### 提取规则`,
    `- 只提取正文实际呈现的爽点，不提取"即将爽"的铺垫或暗示。`,
    `- intensity 1-5：1=微弱正反馈（一句夸奖、一个小发现），3=明显推进（战胜强敌、解开谜题），5=高潮爆发（大逆转、终极揭露、生死抉择）。`,
    `- description 是爽点的自然语言描述（谁做了什么、读者为何感到爽）。`,
    `- setupDescription 是该爽点的前置铺垫（如"前5章被嘲讽低估"），若无明显铺垫可省略。`,
    `- evidence 必须引用正文逐字证据（不少于 8 字），不得概括。`,
    `- 一章可以有 0 到多个爽点；铺陈/相处/余波章可能无爽点，不要为了凑数虚构。`,
    `- 注意区分：narrativeElements.payoffs 追踪"伏笔/承诺的兑现"（结构层），payoffMoments 追踪"读者爽感"（体验层）。一个情节可能同时是两者（如兑现伏笔带来反转爽感），也可能只属于其一。`,
    "",
    `## 优先级`,
    `1. 人物身份、关系、能力、知识边界（影响后续叙事连续性）。`,
    `2. 时间、地点、物件状态（影响事实账本）。`,
    `3. 伏笔、承诺、兑现、未解之谜（影响长篇追读）。`,
    `4. 角色认知变化（谁知道了什么、何时知道）。`,
    "",
    `## 不提取`,
    `- 修辞、隐喻、意象（如"她的心像落叶"）。`,
    `- 读者推断（如"作者暗示她会后悔"）。`,
    `- 已在冻结记忆中存在且无更新的事实（novelty=duplicate 可省略）。`,
    `- narrativeElements 可以为空数组——不要为了凑数虚构伏笔或承诺。`,
    "",
    `## 已存在记忆摘要（用于 novelty/conflict 判断）`,
    input.existingClaimsDigest ?? "- 暂无已存在记忆。所有事实 novelty=new。",
    "",
    `## 章节正文（段落编号仅用于定位）`,
    buildNumberedText(input.text),
    "",
    `## 章节元数据`,
    `- artifactId: ${input.artifact.id}`,
    `- kind: ${input.artifact.kind}`,
    `- baseRevision: ${input.artifact.baseRevision}`,
    `- createdAt: ${new Date(input.artifact.createdAt).toISOString()}`,
  );
  return sections.join("\n");
}

function buildNumberedText(text: string): string {
  const paragraphs = text.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  return paragraphs.map((paragraph, index) => `### 段落 ${index + 1}\n${paragraph}`).join("\n\n");
}

export { factExtractionSchema, type FactExtractionOutput };

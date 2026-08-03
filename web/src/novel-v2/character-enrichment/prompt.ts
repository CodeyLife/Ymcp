import type { Artifact } from "../protocol";
import { characterEnrichmentSchema, type CharacterEnrichmentOutput } from "../prompts/schemas";

/**
 * V2 角色富化（character enrichment）提取 prompt 构造器。
 *
 * 设计依据：AGENTS.md「commitStageHandler → characterEnrichmentStageHandler」契约。
 *
 * 与 fact-extraction/chapter-memory 的区别：
 * - fact-extraction 提取客观事实（subject/predicate/object）
 * - chapter memory 提取章节级高层摘要（summary/keyEvents/...）
 * - character enrichment 提取角色维度的增量变化（声部锚点/动机/知识边界/关系），
 *   让 character-reviewer 审校结果能反哺角色档案，避免「只审不能改」的断裂
 *
 * 设计原则（AGENTS.md「reusable contracts over case-specific examples」）：
 * - prompt 只描述通用提取规则，不嵌入任何题材/类型/角色名 fixture
 * - voiceAnchor 四维（句长/词汇/直率度/回避方式）是题材无关的语言特征
 * - 不内置网文套路识别（走 craft rule 沉淀）
 */

export interface CharacterEnrichmentPromptInput {
  artifact: Artifact;
  text: string;
  /** 已有角色档案摘要（让 LLM 只提取增量变化，避免重复）。 */
  existingCharactersDigest?: string;
}

/**
 * 构建角色富化提取 prompt。
 */
export function buildCharacterEnrichmentPrompt(input: CharacterEnrichmentPromptInput): string {
  return [
    `从下面章节正文中提取角色维度的增量变化（character enrichment delta），用于回写角色档案。`,
    "",
    `## 提取目标`,
    `从定稿章节中识别每个有戏份角色的：声部锚点、动机变化、新获得的知识、关系变化。`,
    `这些增量会回写到 entities.payload（声部/动机）、memory_claims（角色知识边界）、relations（关系），`,
    `让后续章节生成时 character-reviewer 能基于最新角色档案审校，避免角色声部漂移、动机断裂。`,
    "",
    `## 字段说明`,
    `- characterId：角色名（正文中可指认，不用"主角""反派"等代词）。`,
    `- voiceAnchor：本章中该角色的语言风格锚点。`,
    `  - sentenceLength：句长特征（如"短句为主，平均 8-12 字"或"长句堆叠，多用从句"）。`,
    `  - vocabulary：词汇特征（如"口语化，多用方言词"或"书面语，多用典故"）。`,
    `  - directness：直率度（如"直抒胸臆，少修饰"或"含蓄迂回，多用暗示"）。`,
    `  - avoidance：回避方式（如"回避直接冲突，常用反问"或"回避情感表露，常用动作描写"）。`,
    `- motivationDelta：本章动机变化（1-2 句话，如"从复仇转为保护妹妹，意识到仇恨会吞噬自己"）。若本章该角色动机无变化，精确填"无变化"三字（下游按精确匹配识别并跳过，不会污染角色档案）。`,
    `- newKnowledge：本章中该角色新获得的信息边界（谁通过观察、听闻、阅读或推断接触了什么）。每条包含 description（最小可知命题）+ evidence（正文逐字证据）。若无新增信息返回空数组。`,
    `- relationDeltas：本章中该角色的关系变化。targetCharacterId 是另一方角色名，predicate 是关系类型（如"信任""敌对""师徒"），delta 是变化描述（如"从怀疑转为信任"）。若无变化返回空数组。`,
    "",
    `## 提取规则`,
    `- 只提取正文实际呈现的内容，不提取读者推断或作者意图。`,
    `- voiceAnchor 必须基于本章该角色的实际对话/独白，不基于叙述者描写。`,
    `- newKnowledge 的 evidence 必须引用正文逐字证据（不少于 8 字），不得概括。`,
    `- newKnowledge.description 只记录后文判断“角色是否可能知道”所需的最小命题，不复用正文修辞、人物原话或作者总结。观察到的事件写成可观察事实；他人告知的内容写明“听闻/被告知”；角色自行推断的内容写明“怀疑/推测”，不得升级为客观事实。`,
    `- 不把能力原理、价值判断、主题解释、因果寓意或人物评价当作知识事实。只有正文明确让角色形成该判断且该判断会限制后续行动时才记录，并保留“推测/相信”等不确定性。`,
    `- 只列本章有戏份的角色（有对话或心理描写的），不列背景角色。`,
    `- 如果本章无角色戏份（如纯景物描写），characters 返回空数组。`,
    `- motivationDelta 必须描述本章实际呈现的动机变化。判断依据：章节内存在触发事件 + 角色目标/手段/态度的可观察转变。若无变化，精确填"无变化"三字——不要填变体（如"本章无明显动机变化""动机未变化""该角色无动机变化"等），下游按精确字符串匹配跳过，变体会污染角色档案。`,
    "",
    `## motivationDelta 正反例`,
    `正例（有变化）：\`"从复仇转为保护妹妹，意识到仇恨会吞噬自己"\`——基于章节内具体的背叛事件 + 角色态度转变。`,
    `正例（无变化）：\`"无变化"\`——精确三字标记，下游识别后跳过。`,
    `反例（凑数变体）：\`"本章该角色动机无变化"\`、\`"动机未发生变化"\`——这些变体下游无法识别，会被当作真实动机写入角色档案，污染数据。`,
    "",
    `## 已有角色档案摘要（仅供理解上下文，只提取增量）`,
    input.existingCharactersDigest ?? "- 暂无已有角色档案，本章为首章或独立章节。",
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

export { characterEnrichmentSchema, type CharacterEnrichmentOutput };

import { novelDb, type NovelDatabase } from "./db";
import { LONG_FORM_SYSTEM_GUARDRAIL } from "./craft-standards";
import type { NovelSkillStage, PromptTemplateVersion } from "./types";

export const MASTER_PROMPT_TEMPLATE_ID = "long-form-fiction-master";

function builtinTemplate(input: Pick<PromptTemplateVersion, "templateId" | "name" | "description" | "stages" | "content">): PromptTemplateVersion {
  return {
    id: `builtin:${input.templateId}:1.0.0`, projectId: "__builtin__", schemaVersion: 8, revision: 1,
    createdAt: 0, updatedAt: 0, createdBy: "system", updatedBy: "system", version: "1.0.0",
    active: true, source: "builtin", ...input,
  };
}

export const BUILTIN_PROMPT_TEMPLATES: PromptTemplateVersion[] = [
  builtinTemplate({
    templateId: MASTER_PROMPT_TEMPLATE_ID,
    name: "百万字长篇系统守则",
    description: "跨剧情设计、正文、审核和修订的系统级长期质量约束。",
    stages: ["foundation", "planning", "drafting", "review", "revision", "character-enrichment"],
    content: LONG_FORM_SYSTEM_GUARDRAIL,
  }),
  builtinTemplate({
    templateId: "foundation-craft-guidance", name: "基础设定创作指导", description: "控制世界与人物基础设定的可迁移创作方法。", stages: ["foundation"],
    content: "从项目题材、主题承诺和已确认材料推导人物与世界，不得复制提示词示例，不套用示例作品、固定时代、职业、英雄或反派模板。每项设定都应说明它如何产生人物选择、现实阻力或长线变化空间；人物需形成可持续的欲望、恐惧、错误信念、需求、边界和代价，世界规则需明确条件、上限、代价、例外和社会后果。无法进入故事因果的装饰性设定应压缩。\n\n# 架构硬约束创作心法\n长篇架构需满足以下不可降级的结构约束，违反任一条均视为共享指导缺陷而非偶发失误：\n- 阶段转折（turningPoint）不可逆性：转折必须落到资源转移、秘密公开、组织裂变或关系承诺等不可逆变化，不得是事件摘要或中性描述；判断标准是「世界是否回不到此前状态」。\n- 生态曲线独立性：世界的生态/经济/社会演化曲线必须有独立于主线主角和主线技术的驱动力（如资源枯竭、代际交接、人口结构变化），删除主线后仍能推进至少一个阶段。\n- 反馈链闭环：跨权力中心的因果传导链至少 4 步，形成闭环（甲→乙→丙→丁→甲），每步标注不可逆状态变化，不得是单线因果或两步捷径。\n- 伏笔日常化：长线钩子的表面细节不得含「异常/关键/无法解释/神秘/奇怪」等暗示词，必须伪装为完全不引人注意的日常细节，让读者在回收时才意识到线索早已埋下。\n- 权力中心关系非二元化：权力中心之间的关系不得只有纯合作或纯冲突，至少一组关系需同时含合作与冲突的复合语义。",
  }),
  builtinTemplate({
    templateId: "character-enrichment-guidance", name: "人物补全创作指导", description: "从项目证据补全人物，而非套用人设模板。", stages: ["character-enrichment"],
    content: "只根据本项目已确认事实、正文行动与对白补全空缺字段。欲望、动机、弱点、秘密、声音和弧光必须能指回具体证据；信息不足就保留空缺，不使用题材身份模板、示例角色或常见人设补齐。已有字段和未来剧情不得改写或臆造。",
  }),
  builtinTemplate({
    templateId: "planning-craft-guidance", name: "长篇规划创作指导", description: "控制跨章节材料分配、章节功能、节奏差异和长篇余量。", stages: ["planning"],
    content: "大纲用于分配跨章节材料，不是要求尽快完成的任务表。整体故事进度应通过互相穿插的小故事缓慢推进：主线推进剧情段之间应穿插世界观铺陈、群像塑造、支线小故事或呼吸节奏剧情段，让世界更丰富、人物更丰满、感情更厚重。有些支线纯粹讲述世界观或塑造群像人物，不必服务主线，但必须有自身完整的人物处境与因果链。先判断当前层级、本章主导功能、前后因果、人物状态和读者已掌握的信息，再决定哪些内容应当兑现、铺垫、延迟或禁止触碰。背景建立、人物相处、内心发展、情感积累、生活过程和意象生长都可以成为正式章节功能；不得默认每章都要升级冲突、揭晓秘密、跃迁关系或制造同一种章尾压力。节拍数量和信息密度由章节功能、材料复杂度、现场展开空间与篇幅共同决定，informationRelease 可以为空。章尾只需完成本章功能并为后续保持真实驱动力，允许余韵、阶段闭合、状态变化或开放压力，不能为统一模板强造转折、反制和伏笔。",
  }),
  builtinTemplate({
    templateId: "drafting-craft-guidance", name: "章节正文创作指导", description: "控制人物体验、场景因果、长篇节奏和中文文笔质感。", stages: ["drafting"],
    content: "按事实与兑现边界、本章主导叙事功能、人物当下体验与关系、场景因果、语言质感的次序写作。蓝图规定本章可以触碰的材料，不是必须全部结算的清单，不得为完成目标提前消费后续大纲节点。人物声音从年龄、职业、关系距离、目标和既有习惯推导；行动章可以改变局势，铺陈、相处、蓄势或余波章节可以深化世界、人物内心、关系和情感。背景、回忆、生活过程和意象只要深化当下体验就具有叙事价值。以行动、感官、环境和对白承载情绪，含义已经成立后留白，不再补写解释性心理总结；核心意象只在状态或含义变化时重现，段落边界服从注意力、动作因果与情绪停顿。",
  }),
  builtinTemplate({
    templateId: "review-craft-guidance", name: "多维审校指导", description: "按章节功能和正文证据审核剧情、人物、节奏与文笔。", stages: ["review"],
    content: "只报告有正文证据且属于当前审核职责的问题。先判断本章主导功能，不得把安静、铺陈、内省、关系相处或留白结尾本身判为节奏问题。检查是否提前兑现后续节点，或为逐项完成蓝图而压缩背景、内心、情感和关系过程。机械化风险包括事件报表、解释人物心理、用对白传递作者结论、通用细节、匀速段落、重复事件链和第二个结尾；真正的问题是内容重复或体验没有深化。",
  }),
  builtinTemplate({
    templateId: "revision-craft-guidance", name: "定向修订指导", description: "在保留原稿价值的前提下解决经证据确认的问题。", stages: ["revision"],
    content: "修订应追溯问题机制，只处理质量报告确认的范围和原因。保留原稿中有效的人物声音、叙事呼吸、意象与因果连接；可以在允许范围内删除、合并或重排，但不得把定向修订扩张为全章重写，也不得为单项指标牺牲剧情、人物或文体的整体协调。",
  }),
  builtinTemplate({
    templateId: "fact-extraction-guidance", name: "事实抽取指导", description: "从正文提取可追溯事实并保持认知边界。", stages: ["fact-extraction"],
    content: "只抽取正文明确发生、被可靠来源确认或可直接观察的事实。区分客观事实、角色认知、传闻、推测与作者计划；每条事实保留来源位置、主体、时间和置信度，不把修辞、误读或未来意图升级为正式事实。",
  }),
];

function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

export async function listPromptTemplates(projectId: string, db: NovelDatabase = novelDb): Promise<PromptTemplateVersion[]> {
  const project = await db.promptTemplateVersions.where("projectId").equals(projectId).toArray();
  const byId = new Map<string, PromptTemplateVersion>();
  for (const template of BUILTIN_PROMPT_TEMPLATES) byId.set(template.templateId, template);
  for (const template of project.filter((item) => item.active).sort((a, b) => compareVersion(a.version, b.version))) byId.set(template.templateId, template);
  return [...byId.values()];
}

export async function compileSystemPromptGuidance(projectId: string, stage: NovelSkillStage, db: NovelDatabase = novelDb): Promise<{ content: string; refs: string[] }> {
  const templates = (await listPromptTemplates(projectId, db)).filter((template) => template.stages.includes(stage));
  return {
    content: templates.map((template) => `## System Prompt: ${template.name} (${template.templateId}@${template.version})\n${template.content}`).join("\n\n"),
    refs: templates.map((template) => `${template.templateId}@${template.version}`),
  };
}

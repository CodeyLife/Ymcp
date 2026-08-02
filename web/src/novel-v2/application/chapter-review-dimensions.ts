import type { ReviewDimension } from "../prompts/schemas";
import type { ChapterBlueprint } from "./story-arc";

/**
 * 根据冻结章节蓝图声明本章真正需要被正式审核的质量维度。
 *
 * D1/D3/D4/D5 不是每章都必须主动出现；没有对应规则、配角焦点、感情线
 * 或幽默机会时，不把该维度变成误杀提交的硬门槛。plot/hookPayoff 和
 * 非 absent 的主题处理则属于每个可执行章节的基础审校范围。
 */
export function getApplicableChapterReviewDimensions(
  chapter: Pick<ChapterBlueprint, "worldRuleRefs" | "characterFocus" | "romanceTreatment" | "humorTreatment" | "thematicTreatment">,
): ReviewDimension[] {
  const dimensions: ReviewDimension[] = ["plot", "hookPayoff"];
  if (Array.isArray(chapter.worldRuleRefs) && chapter.worldRuleRefs.length) dimensions.push("worldbuilding");
  if (Array.isArray(chapter.characterFocus) && chapter.characterFocus.length) dimensions.push("ensemble");
  if (chapter.romanceTreatment?.status && chapter.romanceTreatment.status !== "not-applicable") dimensions.push("romance");
  if (chapter.humorTreatment?.status && chapter.humorTreatment.status !== "not-applicable") dimensions.push("humor");
  if (chapter.thematicTreatment?.mode && chapter.thematicTreatment.mode !== "absent") dimensions.push("subtext");
  return dimensions;
}

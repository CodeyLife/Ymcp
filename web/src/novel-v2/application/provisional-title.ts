/**
 * 从一句话创意派生临时标题。
 *
 * 设计依据:v1 bootstrapNovelFromCoreIdea 的 provisionalTitle 函数——
 * 取 coreIdea 第一句前 24 字作为临时标题。
 * project-positioning task 会润色创意生成正式书名,此函数只提供初始标题。
 *
 * AGENTS.md 合规:不内置题材/角色 fixture,只做通用字符串处理。
 */
export function provisionalTitle(premise: string): string {
  const firstClause = premise.trim().split(/[，。！？!?\n]/, 1)[0]?.trim() ?? "";
  return firstClause.slice(0, 24) || "未命名小说";
}

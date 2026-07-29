import type { Artifact, ExecutionBlueprint, MemoryBundle } from "../protocol";
import { matchedFacetsOf } from "../cognition";
import type { ChapterPlanningContext } from "../application/story-arc";
import { renderChapterPlanningContext } from "./chapter-planning-context";

/**
 * V2 章节反思（reflection）prompt 构造器。
 *
 * 设计依据：AGENTS.md「root-cause analysis」契约 + Phase 2.4 reflection 机制。
 *
 * 让 LLM 扮演「严苛读者」对自己的草稿做批评，输出 ReflectionCritique
 * （issues + 优先级 + 改写建议）。
 *
 * 与 chapter-review.ts buildChapterReviewPrompt 的区别：
 * - chapter-review 是正式 5 reviewer 审核（产生 commit 证据）
 * - chapter-reflection 是 draft 后的前置自我反思（不产生 commit 证据，只优化 draft）
 * - reflection 关注「读者体验层面的直觉批评」，不强制按 REVIEW_DIMENSIONS 维度切分
 *
 * 与 chapter-draft.ts WRITER_GENERATION_SELF_CHECK 的区别：
 * - WRITER_GENERATION_SELF_CHECK 是草稿生成时的内嵌自检（同一次 LLM 调用内）
 * - reflection 是独立的二次 LLM 调用，让 LLM 以读者视角重新审视已完成的草稿
 */

export interface ReflectionPromptInput {
  artifact: Artifact;
  text: string;
  blueprint: ExecutionBlueprint;
  memory: MemoryBundle;
  planningContext?: ChapterPlanningContext;
}

/**
 * 构造章节反思 prompt。
 *
 * prompt 结构：
 * 1. 角色：严苛读者 + 资深网文编辑
 * 2. 任务：审视草稿，找出会让读者出戏、弃书、感觉平淡的问题
 * 3. 蓝图摘要：本章应该完成什么
 * 4. 草稿正文
 * 5. 输出要求：符合 reflectionSchema 的 JSON
 */
export function buildChapterReflectionPrompt(input: ReflectionPromptInput): string {
  const blueprintDigest = buildBlueprintDigest(input.blueprint);
  const memoryDigest = buildMemoryDigest(input.memory);

  return `你是一位严苛的读者，同时兼具资深网文编辑的视角。你刚刚读完下面这份章节草稿。

# 你的任务

以读者直觉 + 编辑专业的双重视角，审视这份草稿，找出会让读者出戏、弃书、感觉平淡或刻意的问题。不要复述优点，只关注问题。

# 评判维度（不强制每项都提，只提真正有问题的）

- 节奏与拖沓：是否有段落推进缓慢、读者会跳读？
- 情感与代入：是否能引发读者共情？角色情绪是否平铺直叙、缺乏张力？
- 悬念与钩子：章尾是否有让人想继续读的动力？是否过早透露？
- 对白与声部：对白是否冗长说教？角色声部是否混淆？
- 信息密度：是否有信息过载或信息匮乏？伏笔是否埋得太明显？
- 套路与刻板：是否有明显套路化描写？是否有刻板印象？
- 语言与质感：是否有 AI 味浓重的句式（排比、过度比喻、空洞抒情）？
- 蓝图执行：草稿是否偏离本章应有的功能？

# 蓝图摘要

${blueprintDigest}

${input.planningContext ? renderChapterPlanningContext(input.planningContext) : "# 冻结章节规划上下文\n\n（历史章节无规划快照。）"}

# 上下文约束

${memoryDigest}

# 草稿正文

${input.text}

# 输出要求

只输出符合 JSON Schema 的 JSON，不要任何额外文字：

\`\`\`json
{
  "critique": {
    "overallImpression": "1-2 句话的整体印象",
    "issues": [
      {
        "severity": "blocker | major | warning",
        "title": "问题标题",
        "description": "问题具体描述（引用草稿原文片段佐证）",
        "excerpt": "草稿中对应的原文片段（可选）",
        "suggestion": "改写建议（具体到段落或句子，不要泛泛而谈）"
      }
    ]
  }
}
\`\`\`

severity 判定标准：
- blocker：读者会立即弃书的问题（严重出戏、逻辑崩塌、角色崩坏）
- major：读者会跳读或感到明显不满的问题（节奏拖沓、情感平淡、套路化）
- warning：可以优化但不影响阅读的问题（语言质感、信息密度微调）

不要为了凑数虚构问题。如果草稿确实优秀，可以返回空 issues 数组，但在 overallImpression 中说明原因。`;
}

/**
 * 从 ExecutionBlueprint 提取本章应完成的功能摘要。
 */
function buildBlueprintDigest(blueprint: ExecutionBlueprint): string {
  const draftTasks = blueprint.tasks.filter((task) => task.kind === "draft");
  if (!draftTasks.length) return "（无蓝图任务）";
  return draftTasks
    .map((task) => `- 任务：${task.role}（依赖 ${task.dependsOn.length} 个前置任务）`)
    .join("\n");
}

/**
 * 从 MemoryBundle 提取上下文摘要（不重复注入完整 claims，避免 prompt 过长）。
 */
function buildMemoryDigest(memory: MemoryBundle): string {
  const claimCount = memory.claims.length;
  const facetKinds = [...new Set(memory.claims.flatMap(matchedFacetsOf))];
  if (!claimCount) return "（无前章上下文）";
  return `已注入 ${claimCount} 条上下文（facets: ${facetKinds.join(", ")}），narrativeCutoff=${memory.narrativeCutoff ?? "无"}`;
}

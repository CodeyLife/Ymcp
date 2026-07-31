import type { Artifact, ExecutionBlueprint, MemoryBundle } from "../protocol";
import { matchedFacetsOf } from "../cognition";
import type { ChapterPlanningContext } from "../application/story-arc";
import { renderChapterPlanningContext } from "./chapter-planning-context";
import { buildBlueprintSummary } from "./chapter-review";

/**
 * V2 章节反思（reflection）prompt 构造器。
 *
 * 设计依据：AGENTS.md「root-cause analysis」契约 + Phase 2.4 reflection 机制 +
 * 「Fix the problem at the lowest shared layer」——reflection issue schema 已对齐
 * reviewerSchema（含 dimension/rule/revisionRanges/rewriteExample），让 reflection→revision
 * 复用链可透传字段，修复 revise 阶段"按 issue.rule 命中 skill"机制失效。
 *
 * 让 LLM 扮演「严苛读者」对自己的草稿做批评，输出 ReflectionCritique
 * （issues + 优先级 + 改写建议 + 改写示例）。
 *
 * 与 chapter-review.ts buildChapterReviewPrompt 的区别：
 * - chapter-review 是正式 5 reviewer 审核（产生 commit 证据），dimension 用 REVIEW_DIMENSIONS
 * - chapter-reflection 是 draft 后的前置自我反思（不产生 commit 证据，只优化 draft），dimension 用 REFLECTION_DIMENSIONS
 * - reflection 关注「读者体验层面的直觉批评」，8 维度是读者感受维度
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
 * 8 维度判定锚点（与 REFLECTION_DIMENSIONS 枚举对齐）。
 *
 * 设计依据：AGENTS.md「Prompt examples are illustrative, not normative」——
 * 锚点描述通用判定标准，不嵌入题材/类型/角色 fixture。
 */
const REFLECTION_DIMENSION_ANCHORS: Array<{ dimension: string; name: string; anchor: string }> = [
  { dimension: "pace", name: "节奏与拖沓", anchor: "段落是否推进缓慢、读者会跳读？是否有冗余铺垫？" },
  { dimension: "emotion", name: "情感与代入", anchor: "是否能引发读者共情？角色情绪是否平铺直叙、缺乏张力？" },
  { dimension: "suspense", name: "悬念与钩子", anchor: "章尾是否有让人想继续读的动力？是否过早透露？" },
  { dimension: "dialogue", name: "对白与声部", anchor: "对白是否冗长说教？角色声部是否混淆？" },
  { dimension: "density", name: "信息密度", anchor: "是否有信息过载或信息匮乏？伏笔是否埋得太明显？" },
  { dimension: "trope", name: "套路与刻板", anchor: "是否有明显套路化描写？是否有刻板印象？" },
  { dimension: "language", name: "语言与质感", anchor: "是否有 AI 味浓重的句式（排比、过度比喻、空洞抒情）？" },
  { dimension: "blueprint", name: "蓝图执行", anchor: "草稿是否偏离本章应有的功能（章节功能/章尾驱动力见蓝图摘要）？" },
];

/**
 * 构造章节反思 prompt。
 *
 * prompt 结构：
 * 1. 角色：严苛读者 + 资深网文编辑
 * 2. 任务：审视草稿，找出会让读者出戏、弃书、感觉平淡的问题
 * 3. 评判维度与锚点（8 维度，按草稿实际选择相关维度）
 * 4. 蓝图摘要（公共函数，含章节功能/章尾驱动力）
 * 5. 草稿正文
 * 6. 输出要求：符合 reflectionSchema 的 JSON（含完整 issue 正例 + 空 issues 合法形态）
 */
export function buildChapterReflectionPrompt(input: ReflectionPromptInput): string {
  const blueprintDigest = buildBlueprintSummary(input.blueprint, input.planningContext);
  const memoryDigest = buildMemoryDigest(input.memory);
  const dimensionLines = REFLECTION_DIMENSION_ANCHORS.map(
    (item) => `- **${item.name}**（dimension: \`${item.dimension}\`）：${item.anchor}`,
  ).join("\n");

  return `你是一位严苛的读者，同时兼具资深网文编辑的视角。你刚刚读完下面这份章节草稿。

# 你的任务

以读者直觉 + 编辑专业的双重视角，审视这份草稿，找出会让读者出戏、弃书、感觉平淡或刻意的问题。不要复述优点，只关注问题。

# 评判维度与锚点

按草稿实际选择相关维度提 issue；无相关问题的维度不输出 issue，不要为凑数虚构问题。每个 issue 必须填写对应的 dimension 字段。

${dimensionLines}

# 篇幅边界

字数、字符数、段落数量或是否达到某个目标篇幅，不是反思/审校目标，也不能单独触发 blocker、major 或 warning。只能批评可由正文证据证明的阅读机制：章节功能是否完成、信息是否抵达、情绪/关系/因果是否有承载、是否重复空转或提前消费后续节点。若你想指出篇幅相关问题，必须改写为具体机制（例如"关键转折缺少可观察承载""多段重复同一信息""章尾在结果出现前收束"），并引用正文片段；找不到机制证据时不得输出 issue。

# 蓝图摘要

${blueprintDigest}

${input.planningContext ? renderChapterPlanningContext(input.planningContext) : "# 冻结章节规划上下文\n\n（历史章节无规划快照。）"}

# 上下文约束

${memoryDigest}

# 草稿正文

${input.text}

# 输出要求

只输出符合 JSON Schema 的 JSON，不使用 Markdown 代码块，不输出任何额外文字。

## issue 字段说明

- dimension：上述 8 维度之一（pace/emotion/suspense/dialogue/density/trope/language/blueprint）
- severity：blocker / major / warning
- title：问题标题
- description：问题具体描述，必须引用草稿原文片段佐证
- excerpt：草稿中对应的原文片段（可选）
- paragraph：草稿段落编号（可选，用于定位）
- revisionRanges：建议修订的段落范围数组（必填，无明确范围时填空数组 \`[]\`）
- rule：问题对应的规则短标识（如 \`reflection.pace-drag\`、\`reflection.language-ai-taste\`），用于下游修订按规则命中技能
- suggestion：改写建议（具体到段落或句子，不要泛泛而谈）
- rewriteExample：具体改写示例（必填，minLength=1），格式为「【原文】...（截取关键句）【改写】...（建议文本）」

## severity 判定标准

- blocker：读者会立即弃书的问题（严重出戏、逻辑崩塌、角色崩坏）
- major：读者会跳读或感到明显不满的问题（节奏拖沓、情感平淡、套路化）
- warning：可以优化但不影响阅读的问题（语言质感、信息密度微调）

## rewriteExample 必填说明

JSON schema 已将 rewriteExample 设为必填字段（minLength=1）。任何 issue 缺少 rewriteExample 或填空字符串都会被 schema 拒绝，整个反思调用将失败。
- 对 blocker / major 问题：rewriteExample 必须给出具体改写文本，格式为「【原文】...（截取关键句）【改写】...（建议文本）」。禁止只说"删除该句"——必须给出改写后的实际文本。
- 对 warning 问题：rewriteExample 给出 1-2 句精简改写示例或方向性示意即可，但仍不得为空。
- 若某问题确实无改写示例（如纯结构问题），rewriteExample 填写说明性短语如「结构问题，需在 X 段增加 Y 元素」，不可留空。

## 正例：一个完整 issue

\`\`\`json
{
  "dimension": "pace",
  "severity": "major",
  "title": "第二段铺陈过长，读者会跳读",
  "description": "第二段用 8 句描写主角走进密室的过程，无新信息也无情绪推进，读者会跳读。原文：『他一步一步走向那扇门，每一步都显得格外沉重，门上的纹路在火光下若隐若现……』",
  "excerpt": "他一步一步走向那扇门，每一步都显得格外沉重",
  "paragraph": 2,
  "revisionRanges": [{ "start": 2, "end": 2 }],
  "rule": "reflection.pace-drag",
  "suggestion": "将第二段压缩为 2-3 句，把环境信息并入主角的行动决策中。",
  "rewriteExample": "【原文】他一步一步走向那扇门，每一步都显得格外沉重，门上的纹路在火光下若隐若现……【改写】他在门前停下。纹路在火光下扭动，像活物。他推开门。"
}
\`\`\`

## 合法形态：空 issues 数组

如果草稿确实优秀，可以返回空 issues 数组，但在 overallImpression 中说明原因：

\`\`\`json
{
  "critique": {
    "overallImpression": "草稿节奏紧凑，情感有张力，章尾钩子有效，无需修订。",
    "issues": []
  }
}
\`\`\`

不要为了凑数虚构问题。`;
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

import type { ChapterPlanningContext } from "../application/story-arc";

function list(items: string[], empty = "无"): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

export function renderChapterPlanningContext(context: ChapterPlanningContext): string {
  const chapter = context.chapter;
  const scenes = chapter.scenes.length
    ? chapter.scenes.map((scene, index) => [
      `### 场景 ${index + 1}：${scene.title}`,
      `- 摘要：${scene.summary}`,
      `- 目标：${scene.goal || "未限定"}`,
      `- 参与人物：${scene.participants.join("、") || "未限定"}`,
      `- 转折：${scene.turn || "未限定"}`,
      `- 结果：${scene.outcome || "未限定"}`,
    ].join("\n")).join("\n\n")
    : "- 未预设场景，允许作者在章节功能和连续性边界内组织场景。";
  const neighbors = context.neighbors.length
    ? context.neighbors.map((item) => `- 第 ${item.globalOrder} 章《${item.title}》：${item.chapterPurpose}；${item.summary}`).join("\n")
    : "- 无相邻章节蓝图。";
  const macro = context.macroPlanArtifacts.length
    ? context.macroPlanArtifacts.map((item) => `- [${item.taskKey}] ${item.title}：${item.summary}`).join("\n")
    : "- 无宏观规划摘要。";

  return [
    `## 冻结章节规划上下文`,
    `规划上下文指纹：${context.fingerprint}`,
    `### 当前故事弧：${context.arc.title}`,
    `- 创作目的：${context.arc.objective}`,
    `- 入场状态：${context.arc.entryState}`,
    `- 核心冲突：${context.arc.centralConflict}`,
    `- 发展路径：${context.arc.development.join("；") || "未限定"}`,
    `- 收束方式：${context.arc.resolution}`,
    `- 离场状态：${context.arc.exitState}`,
    `### 目标章：第 ${chapter.globalOrder} 章《${chapter.title}》`,
    `- 摘要：${chapter.summary}`,
    `- 章节功能：${chapter.chapterPurpose}`,
    `- 戏剧问题：${chapter.dramaticQuestion}`,
    `- POV：${chapter.povCharacterId || "未限定"}`,
    `- 情绪运动：${chapter.emotionalMovement}`,
    `- 状态变化预算：${chapter.stateDeltaBudget}`,
    `- 章尾驱动力：${chapter.closingForce}`,
    `- 允许自由发挥：${chapter.freedom}`,
    `### 连续性硬约束`,
    list(chapter.continuityConstraints),
    `### 伏笔与兑现引用`,
    `- 铺设：${chapter.setupRefs.join("、") || "无"}`,
    `- 兑现：${chapter.payoffRefs.join("、") || "无"}`,
    `### 可选节拍`,
    `${list(chapter.optionalBeats, "无；不得自行发明必须完成的节拍")}`,
    `这些节拍是可选组织材料，不是逐项打勾的任务清单。只要章节功能、状态变化预算与连续性约束成立，可以调整、合并或省略。`,
    `### 场景蓝图`,
    scenes,
    `### 相邻章摘要（只用于衔接，不得提前消费）`,
    neighbors,
    `### 宏观规划摘要（长期软参考）`,
    macro,
    `### 约束优先级`,
    `目标章功能、状态变化预算、连续性约束、人物知识边界和故事弧离场边界是硬约束。宏观节奏、其他剧情线与可选节拍是软参考；不得为了覆盖它们而压缩故事、提前兑现后续节点，安静、铺陈、关系、内省、情感积累或文学意象章节同样可以构成有效进展。`,
  ].join("\n\n");
}

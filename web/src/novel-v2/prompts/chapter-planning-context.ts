import type { ChapterPlanningContext } from "../application/story-arc";
import type { MemoryBundle, MemoryClaim, NarrativeRhythmSnapshot } from "../protocol";

function list(items: string[], empty = "无"): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

export function renderNarrativeRhythm(rhythm: NarrativeRhythmSnapshot | undefined, options: { execution?: boolean } = {}): string {
  if (!rhythm?.chapters.length) return "- 当前故事弧暂无已定稿前序章节。";
  return rhythm.chapters.map((chapter) => {
    const isLegacy = !chapter.narrativeFunction;
    if (options.execution && isLegacy) {
      return `- 第 ${chapter.narrativeOrder} 章《${chapter.title}》：[legacy/subtext/none] 已定稿前史；具体连续性以本包原子事实为准，不把历史概括与解释性措辞带入正文。既有问题族：${chapter.issueFamilies.join("、") || "无"}`;
    }
    return [
      `- 第 ${chapter.narrativeOrder} 章《${chapter.title}》：[${chapter.narrativeFunction ?? "legacy"}/${chapter.thematicMode ?? "subtext"}/${chapter.themeCarrier ?? "none"}] ${chapter.summary}`,
      `  关键事件：${chapter.keyEvents.join("；") || "无"}；情绪：${chapter.emotionalArc || "未记录"}；既有问题族：${chapter.issueFamilies.join("、") || "无"}`,
    ].join("\n");
  }).join("\n");
}

/** Keep committed chapter history in one representation when a rhythm snapshot is available. */
export function dedupeNarrativeRhythmMemory(memory: MemoryBundle): MemoryBundle {
  const revisionIds = new Set((memory.narrativeRhythm?.chapters ?? [])
    .map((chapter) => chapter.revisionId)
    .filter((revisionId): revisionId is string => Boolean(revisionId)));
  const claims = memory.claims.filter((claim) => {
    if (claim.id.startsWith("foundation:")) return false;
    const isChapterDigest = claim.matchedFacet === "chapter-memory"
      || claim.id.startsWith("pinned:memory:chapter:")
      || claim.id.startsWith("memory:chapter:");
    return !isChapterDigest || !claim.sourceRevisionIds.some((revisionId) => revisionIds.has(revisionId));
  });
  return claims.length === memory.claims.length ? memory : { ...memory, id: `${memory.id}:without-rhythm-duplicates`, claims };
}

/**
 * Character-scoped memory is an epistemic boundary, not prose or an objective
 * world fact. Keep its proposition available for continuity while preventing
 * old narration, evidence quotes, or a character's interpretation from being
 * promoted into the next chapter's authorial voice.
 */
export function renderExecutionMemoryClaim(claim: MemoryClaim): { title: string; text: string } {
  if (claim.knowledgeScope === "author") return { title: claim.title, text: claim.content };
  const characterId = claim.knowledgeScope.characterId;
  const proposition = claim.content
    .split(/\n证据：/u, 1)[0]
    .replace(/^.+?在第\d+章得知：/u, "")
    .trim();
  return {
    title: `角色知识边界：${characterId}`,
    text: [
      `可知命题：${proposition || claim.title}`,
      "使用边界：只据此判断该角色能否知晓相关信息。它可能记录角色当时的观察、转述、推测或旧稿措辞；不得照搬为对白、叙述、主题结论或客观世界规则，也不要求本章主动提及。",
    ].join("\n"),
  };
}

export function renderChapterPlanningContext(context: ChapterPlanningContext, options: { includeMacro?: boolean } = {}): string {
  const chapter = context.chapter;
  const isExecutionProjection = options.includeMacro === false;
  const isLegacyChapter = !chapter.narrativeFunction || !chapter.readerExperience || !chapter.thematicTreatment;
  const thematicTreatment = chapter.thematicTreatment ?? {
    mode: "subtext" as const,
    questionRefs: [],
    carrier: "choice" as const,
    evidenceChange: "历史蓝图未声明主题推进；本章只允许从具体行动与后果产生潜台词。",
    expositionBoundary: "不得把旧 chapterPurpose 中的抽象立意当作必须写进正文的结论。",
  };
  const scenes = chapter.scenes.length
    ? chapter.scenes.map((scene, index) => [
      `### 场景 ${index + 1}：${scene.title}`,
      ...(!isExecutionProjection || !isLegacyChapter ? [`- 摘要：${scene.summary}`] : []),
      ...(!isExecutionProjection || !isLegacyChapter ? [`- 目标：${scene.goal || "未限定"}`] : []),
      ...(!isExecutionProjection || !isLegacyChapter ? [`- 阻力：${scene.opposition || "未限定"}`] : []),
      `- 参与人物：${scene.participants.join("、") || "未限定"}`,
      ...(!isExecutionProjection || !isLegacyChapter ? [`- 各方利益：${scene.participantStakes?.map((stake) => {
        const basis = stake.knowledgeBasis;
        return `${stake.participant}[欲望=${stake.want || "未知"}(${basis?.want ?? "legacy"})；筹码=${stake.leverage || "未知"}(${basis?.leverage ?? "legacy"})；保留信息=${stake.withholding || "未知"}(${basis?.withholding ?? "legacy"})；失败代价=${stake.failureCost || "未知"}(${basis?.failureCost ?? "legacy"})]`;
      }).join("；") || "未限定"}`] : []),
      ...(!isExecutionProjection || !isLegacyChapter ? [`- 转折：${scene.turn || "未限定"}`, `- 结果：${scene.outcome || "未限定"}`, `- 代价：${scene.cost || "未限定"}`] : []),
    ].join("\n")).join("\n\n")
    : "- 未预设场景，允许作者在章节功能和连续性边界内组织场景。";
  const neighbors = context.neighbors.length
    ? context.neighbors.map((item) => {
      const contract = item.narrativeFunction && item.readerExperience
        ? `[${item.narrativeFunction}/${item.thematicTreatment?.mode ?? "subtext"}] ${item.readerExperience}；规则=${item.worldRuleRefs?.join("、") || "无"}；群像=${item.characterFocus?.map((focus) => focus.characterRef).join("、") || "无"}；感情=${item.romanceTreatment?.status ?? "legacy"}；幽默=${item.humorTreatment?.status ?? "legacy"}`
        : isExecutionProjection
          ? "[legacy] 仅标记相邻章节位置；事件连续性以叙事节奏和冻结原子事实为准。"
          : `[legacy] ${item.summary}`;
      return `- 第 ${item.globalOrder} 章《${item.title}》：${contract}`;
    }).join("\n")
    : "- 无相邻章节蓝图。";
  const macro = context.macroPlanArtifacts.length
    ? context.macroPlanArtifacts.map((item) => `- [${item.taskKey}] ${item.title}：${item.summary}`).join("\n")
    : "- 无宏观规划摘要。";

  const arcContext = isExecutionProjection
    ? [
      `### 当前故事弧：${context.arc.title}`,
      ...(isLegacyChapter
        ? ["- 执行边界：历史蓝图未区分弧级主题与章级任务；正文只执行目标章可观察事件、状态预算和连续性约束，不复述故事弧目标或预演弧级答案。"]
        : [
          `- 入场状态：${context.arc.entryState}`,
          `- 离场边界（不得由本章提前完成）：${context.arc.exitState}`,
        ]),
    ]
    : [
      `### 当前故事弧：${context.arc.title}`,
      `- 故事弧目标：${context.arc.objective}`,
      `- 入场状态：${context.arc.entryState}`,
      `- 核心冲突：${context.arc.centralConflict}`,
      `- 发展路径：${context.arc.development.join("；") || "未限定"}`,
      `- 收束方式：${context.arc.resolution}`,
      `- 离场状态：${context.arc.exitState}`,
    ];

  return [
    `## 冻结章节规划上下文`,
    `规划上下文指纹：${context.fingerprint}`,
    ...arcContext,
    `### 目标章：第 ${chapter.globalOrder} 章《${chapter.title}》`,
    ...(isExecutionProjection && isLegacyChapter ? ["- 历史蓝图正文投影：旧摘要、chapterPurpose、场景解释与抽象转折不进入正文任务；只保留下方事件骨架、状态边界和连续性约束。"] : [`- 摘要：${chapter.summary}`]),
    ...(!isExecutionProjection || !isLegacyChapter ? [`- 章节功能：${chapter.chapterPurpose}`] : []),
    ...(!isExecutionProjection || !isLegacyChapter ? [`- 状态变化：${chapter.stateTransition ? `${chapter.stateTransition.before} -> ${chapter.stateTransition.after}；证据=${chapter.stateTransition.evidence}` : "未结构化"}`] : []),
    `- 主导叙事功能：${chapter.narrativeFunction ?? "legacy（从本章事件与体验推断，不按抽象立意执行）"}`,
    `- 读者体验：${chapter.readerExperience ?? "历史蓝图未记录；从本章可观察事件与状态预算推断，不把摘要措辞当成必须复述的体验结论。"}`,
    `- 主题显隐：${thematicTreatment.mode}`,
    `- 主题问题引用：${thematicTreatment.questionRefs.join("、") || "无"}`,
    `- 主题承载：${thematicTreatment.carrier}`,
    `- 本章只改变的证据：${thematicTreatment.evidenceChange || "无；不主动触碰主题"}`,
    `- 解释边界：${thematicTreatment.expositionBoundary || "不得由作者或人物直接总结主题"}`,
    `- 世界规则引用：${chapter.worldRuleRefs.join("、") || "无；先确认不调用新规则"}`,
    `- 群像焦点：${chapter.characterFocus.map((focus) => `${focus.characterRef}[功能=${focus.function}；欲望=${focus.desire}；行动=${focus.action}；代价=${focus.cost}]`).join("；") || "无；本章不强制加入配角"}`,
    `- 感情线处理：${chapter.romanceTreatment.status}；阶段=${chapter.romanceTreatment.stage || "无"}；行动证据=${chapter.romanceTreatment.actionEvidence || "无"}；边界=${chapter.romanceTreatment.boundary}`,
    `- 幽默处理：${chapter.humorTreatment.status}；机会=${chapter.humorTreatment.opportunity || "无"}；情境证据=${chapter.humorTreatment.evidence || "无"}；边界=${chapter.humorTreatment.boundary}`,
    `- 戏剧问题：${chapter.dramaticQuestion}`,
    `- POV：${chapter.povCharacterId || "未限定"}`,
    `- 情绪运动：${chapter.emotionalMovement}`,
    `- 状态变化预算：${chapter.stateDeltaBudget}`,
    ...(chapter.narrativeScale ? [
      `- 叙事规模：${chapter.narrativeScale.level}（${chapter.narrativeScale.reason}；这是非硬性的体量信号，不是字数下限）`,
      `- 规模展开轴：${chapter.narrativeScale.developmentAxes.join("；")}`,
      `- 自然收束条件：${chapter.narrativeScale.stoppingCondition}`,
    ] : [
      "- 叙事规模：未声明（仅适用于尚未经过运行时归一化的旧上下文；旧蓝图正常按 standard 软信号处理，不得把缺失字段解释成短章许可，也不得凭字符数硬判）",
    ]),
    `- 章尾驱动力：${chapter.closingForce}`,
    ...(!isExecutionProjection || !isLegacyChapter ? [`- 允许自由发挥：${chapter.freedom}`] : []),
    `### 连续性硬约束`,
    list(chapter.continuityConstraints),
    `### 章末仍未解（不得写成客观结论）`,
    list(chapter.unresolvedAtClose ?? [], "无结构化未解项"),
    `### 伏笔与兑现引用`,
    `- 铺设：${chapter.setupRefs.join("、") || "无"}`,
    `- 兑现：${chapter.payoffRefs.join("、") || "无"}`,
    ...(!isExecutionProjection || !isLegacyChapter ? [
      `### 可选节拍`,
      `${list(chapter.optionalBeats, "无；不得自行发明必须完成的节拍")}`,
      `这些节拍是可选组织材料，不是逐项打勾的任务清单。只要章节功能、状态变化预算与连续性约束成立，可以调整、合并或省略。`,
    ] : []),
    `### 场景蓝图`,
    scenes,
    `### 相邻章摘要（只用于衔接，不得提前消费）`,
    neighbors,
    ...(isExecutionProjection ? [] : [`### 长程叙事战略摘要（仅供规划阶段长期参考）`, macro]),
    `### 约束优先级`,
    `${isExecutionProjection && isLegacyChapter ? "已定稿事实与叙事状态账本、目标章可观察事件、状态变化预算、连续性约束和人物知识边界是硬约束。历史 chapterPurpose、抽象场景目标与故事弧主题不是正文任务。" : "已定稿事实与叙事状态账本、目标章功能、状态变化预算、连续性约束、人物知识边界和故事弧离场边界是硬约束。"}长程战略、宏观节奏、其他剧情线与可选节拍是软参考；不得为了覆盖它们而压缩故事、提前兑现后续节点，安静、铺陈、关系、内省、情感积累或文学意象章节同样可以构成有效进展。`,
  ].join("\n\n");
}

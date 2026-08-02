/**
 * Chapter-scale planning signal. It describes how deeply the current
 * narrative function should be experienced, never a character-count gate.
 */
export const CHAPTER_NARRATIVE_SCALE_LEVELS = ["compact", "standard", "extended"] as const;
export type ChapterNarrativeScaleLevel = (typeof CHAPTER_NARRATIVE_SCALE_LEVELS)[number];

export interface ChapterNarrativeScale {
  level: ChapterNarrativeScaleLevel;
  reason: string;
  developmentAxes: string[];
  stoppingCondition: string;
}

/**
 * Old chapter blueprints have no explicit scale. Treat them as ordinary
 * chapters until their existing function and state boundary are complete;
 * this is a soft compatibility cue, never a character-count minimum.
 */
export function defaultChapterNarrativeScale(): ChapterNarrativeScale {
  return {
    level: "standard",
    reason: "旧蓝图未声明展开深度，按普通长篇章节完整承载本章已有功能",
    developmentAxes: [
      "把核心处境落实为连续的可感过程",
      "让人物在同一处境中经历判断、行动或关系变化",
      "呈现选择后的代价与余波",
    ],
    stoppingCondition: "本章既定状态变化已经通过可观察行动与后果成立，且本章功能不再有未经历的必要阶段",
  };
}

import type { Artifact } from "../protocol";

export type ProjectPlanStatus =
  | "locked"
  | "ready"
  | "generating"
  | "awaiting-confirmation"
  | "approved"
  | "stale"
  | "failed";

export interface ProjectPlanSection {
  projectId: string;
  taskKey: ProjectPlanTaskKey;
  workItemId?: string;
  sourceArtifactId?: string;
  status: ProjectPlanStatus;
  payload: Record<string, unknown>;
  editRevision: number;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const PROJECT_PLAN_STAGES = [
  { taskKey: "project-positioning", label: "项目定位", dependsOn: [], instruction: "完成项目定位、目标读者与核心叙事承诺" },
  { taskKey: "architecture", label: "全书架构", dependsOn: ["project-positioning"], instruction: "设计整体叙事架构、卷级推进与章节布局" },
  { taskKey: "characters", label: "主要人物", dependsOn: ["project-positioning"], instruction: "设计主要人物档案、动机、声部与变化弧" },
  { taskKey: "worldview", label: "世界观", dependsOn: ["project-positioning"], instruction: "构建世界观、力量规则与不可违反的事实" },
  { taskKey: "relations", label: "人物关系", dependsOn: ["characters", "worldview"], instruction: "设计人物关系、冲突与关系变化路径" },
  { taskKey: "plot-threads", label: "剧情线", dependsOn: ["architecture", "characters", "worldview"], instruction: "设计主线、支线及其因果关系" },
  { taskKey: "foreshadowing", label: "伏笔规划", dependsOn: ["plot-threads"], instruction: "设计伏笔、承诺、预期兑现窗口与回收节点" },
  { taskKey: "timeline", label: "时间线", dependsOn: ["plot-threads", "worldview"], instruction: "构建故事时间线与关键事件顺序" },
  { taskKey: "story-control", label: "叙事控制", dependsOn: ["architecture", "plot-threads"], instruction: "设计信息释放、节奏变化与叙事控制点" },
  { taskKey: "plot-design", label: "情节设计", dependsOn: ["relations", "foreshadowing", "timeline", "story-control"], instruction: "形成可执行的情节设计与章节推进原则" },
] as const;

export type ProjectPlanStageTaskKey = (typeof PROJECT_PLAN_STAGES)[number]["taskKey"];
export type ProjectPlanTaskKey = ProjectPlanStageTaskKey | "chapter-plan";

export const REQUIRED_APPROVED_PLAN_TASK_KEYS = [
  "architecture",
  "characters",
  "worldview",
  "plot-design",
] as const satisfies readonly ProjectPlanTaskKey[];

const stageByKey = new Map<string, (typeof PROJECT_PLAN_STAGES)[number]>(
  PROJECT_PLAN_STAGES.map((stage) => [stage.taskKey, stage]),
);

export function isProjectPlanTaskKey(value: string): value is ProjectPlanTaskKey {
  return value === "chapter-plan" || stageByKey.has(value);
}

export function planStage(taskKey: ProjectPlanTaskKey) {
  return stageByKey.get(taskKey);
}

export function transitivePlanDependents(taskKey: ProjectPlanTaskKey): ProjectPlanTaskKey[] {
  const result = new Set<ProjectPlanTaskKey>();
  const visit = (key: ProjectPlanTaskKey) => {
    for (const stage of PROJECT_PLAN_STAGES) {
      if (stage.dependsOn.includes(key as never) && !result.has(stage.taskKey)) {
        result.add(stage.taskKey);
        visit(stage.taskKey);
      }
    }
  };
  visit(taskKey);
  return [...result];
}

export function foundationTaskKey(artifact: Artifact): ProjectPlanTaskKey | undefined {
  const value = artifact.structuredData?.taskKey;
  if (typeof value === "string" && isProjectPlanTaskKey(value)) return value;
  return undefined;
}

/**
 * 从已通过人工/运行时审批的项目定位中读取正式中文书名。
 * 书名必须由 positioning 明确产出，不从摘要、题材或项目 ID 猜测。
 */
export function approvedProjectBookTitle(payload: Record<string, unknown>): string | undefined {
  const structuredData = payload.structuredData;
  if (!structuredData || typeof structuredData !== "object" || Array.isArray(structuredData)) return undefined;
  const positioning = (structuredData as Record<string, unknown>).positioning;
  if (!positioning || typeof positioning !== "object" || Array.isArray(positioning)) return undefined;
  const raw = (positioning as Record<string, unknown>).bookTitle;
  if (typeof raw !== "string") return undefined;
  const title = raw.trim().replace(/^《|》$/gu, "").trim();
  if (!title || title.length > 40 || !/\p{Script=Han}/u.test(title)) return undefined;
  return title;
}

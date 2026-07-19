/**
 * Bench 实验 DB 适配器：在物理隔离的实验库上运行 bench，并提供正式库哈希不变量断言。
 *
 * 设计目的（goal novel-eval-loop Loop 3）：
 * - 不再让 bench 测试直接污染全局 `novelDb`；改为通过 `loadProjectSnapshotIntoExperiment`
 *   把正式库快照注入到独立 Dexie 实例，bench 在实验库上写入。
 * - 在 bench 启动前后捕获正式库的 `ProjectSnapshotBundle.manifest.snapshotHash`，
 *   断言哈希不变——这是闭环评估"零正式库污染"的物理证据。
 *
 * 已知限制（Loop 3 不解决，留待后续 loop）：
 * - `novelMemoryService` 单例和 `compileNovelContext` 仍硬编码到全局 `novelDb`，
 *   所以 `context-stage.ts` 与 bench-smoke 的预工作流步骤（getOrCreateThread 等）
 *   会写到全局 `novelDb`。要跑完整章节工作流于实验库，需要先重构这些模块接受 `db` 参数。
 * - 本模块当前提供的是"Loop 2 seam 在实验库上可写"的结构性证据，不依赖 LLM。
 */
import { novelDb, type NovelDatabase } from "../../db";
import {
  captureProjectSnapshot,
  type ProjectSnapshotBundle,
  type SnapshotReason,
} from "../../evaluation/project-snapshot";
import {
  loadProjectSnapshotIntoExperiment,
  type ExperimentWorkspace,
} from "../../evaluation/experiment-workspace";

// ===== 正式库哈希不变量 =====

/**
 * 捕获正式库当前快照哈希，用于 bench 启动前后的不变量断言。
 *
 * 仅捕获哈希，不保留完整 bundle（bench 期间不需要记录体）。
 */
export async function captureCanonicalHash(
  projectId: string,
  reason: SnapshotReason = "chapter-baseline",
): Promise<string> {
  const bundle = await captureProjectSnapshot(novelDb, projectId, reason);
  return bundle.manifest.snapshotHash;
}

/**
 * 捕获正式库完整快照 bundle，供后续 loadProjectSnapshotIntoExperiment 使用。
 */
export async function captureCanonicalSnapshot(
  projectId: string,
  reason: SnapshotReason = "chapter-baseline",
): Promise<ProjectSnapshotBundle> {
  return captureProjectSnapshot(novelDb, projectId, reason);
}

/**
 * 断言正式库快照哈希未变化。
 *
 * 在 bench 启动前调用 `captureCanonicalHash` 得到 `before`，
 * bench 结束后再次捕获得到 `after`，调用本函数验证零正式库污染。
 */
export function assertCanonicalHashUnchanged(
  before: string,
  after: string,
  message = "正式库哈希在 bench 期间发生变化：检测到 bench 写入污染了正式库",
): void {
  if (before !== after) {
    throw new Error(
      `${message}\n  before: ${before}\n  after:  ${after}`,
    );
  }
}

// ===== 实验库加载 =====

/**
 * 从正式库捕获快照并加载到物理隔离的实验库。
 *
 * 步骤：
 * 1. `captureProjectSnapshot(novelDb, projectId, reason)` 捕获正式库
 * 2. `loadProjectSnapshotIntoExperiment(bundle, experimentId)` 创建实验库并恢复快照
 *
 * 返回实验工作区句柄 + 基线哈希。调用方必须在工作区使用完毕后调用 `workspace.delete()`。
 */
export async function seedExperimentFromCanonical(
  projectId: string,
  experimentId: string,
  reason: SnapshotReason = "chapter-baseline",
): Promise<{ workspace: ExperimentWorkspace; baseHash: string; bundle: ProjectSnapshotBundle }> {
  const bundle = await captureCanonicalSnapshot(projectId, reason);
  const { workspace } = await loadProjectSnapshotIntoExperiment(bundle, experimentId);
  return { workspace, baseHash: bundle.manifest.snapshotHash, bundle };
}

// ===== 实验库 foundation 加载（兼容旧 FoundationSnapshot 形状） =====

/**
 * 旧式 FoundationSnapshot 结构：9 张地基表 + project。
 *
 * 由 bench-bootstrap.test.ts 生成，被 bench-smoke/draft/review/revision 复用。
 * 本接口与 bench-helpers.ts 中的 FoundationSnapshot 保持一致，但写入目标改为实验库。
 */
export interface FoundationSnapshot {
  project: unknown;
  architectures: unknown[];
  entities: unknown[];
  relations: unknown[];
  outlineNodes: unknown[];
  scenes: unknown[];
  plotThreads: unknown[];
  foreshadowing: unknown[];
  timelineEvents: unknown[];
  documents: unknown[];
}

const FOUNDATION_TABLES = [
  "architectures",
  "entities",
  "relations",
  "outlineNodes",
  "scenes",
  "plotThreads",
  "foreshadowing",
  "timelineEvents",
  "documents",
] as const;

/**
 * 将 foundation fixture 加载到指定实验库（而非全局 novelDb）。
 *
 * 用于：bench 切片测试希望以 fixture 为起点但写入实验库的场景。
 * 注意：本函数不捕获正式库哈希——调用方需自行调用 `captureCanonicalHash` 做不变量断言。
 */
export async function loadFoundationIntoExperimentDb(
  snapshot: FoundationSnapshot,
  db: NovelDatabase,
): Promise<void> {
  if (snapshot.project) await db.projects.put(snapshot.project as never);
  for (const table of FOUNDATION_TABLES) {
    const records = snapshot[table];
    if (records && records.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any)[table].bulkPut(records);
    }
  }
}

/**
 * 实验工作区:管理隔离 Dexie 实例的生命周期。
 *
 * architecture §4.2 / §8。本模块负责:
 * - 从 ProjectSnapshotBundle 创建并初始化隔离实验数据库
 * - 提供实验库的访问句柄 + 关键查询便利方法
 * - 实验结束后清理 Dexie 实例
 *
 * 不做正式库写入。所有正式库写入必须经 PromotionService。
 */
import type { NovelDatabase } from "../db";
import {
  createExperimentDatabase,
  restoreProjectSnapshot,
  verifyProjectSnapshot,
  type ProjectSnapshotBundle,
  type SupportedProjectSnapshotBundle,
  type SnapshotVerification,
} from "./project-snapshot";

/**
 * 实验工作区句柄。
 *
 * 调用方必须在工作区使用完毕后调用 `close()` 释放 Dexie 实例,
 * 否则会在浏览器 IndexedDB 中残留实验库。
 */
export interface ExperimentWorkspace {
  /** 物理隔离的实验数据库实例 */
  readonly db: NovelDatabase;
  /** 实验 ID,用于命名实验库 */
  readonly experimentId: string;
  /** 实验库对应的源项目 ID */
  readonly projectId: string;
  /** 基线快照 ID */
  readonly baseSnapshotId: string;
  /** 基线快照 hash,用于晋升时校验 */
  readonly baseSnapshotHash: string;
  /** 关闭实验库,释放 Dexie 资源 */
  close(): Promise<void>;
  /** 删除实验库的物理数据(谨慎使用) */
  delete(): Promise<void>;
}

export interface LoadSnapshotResult {
  workspace: ExperimentWorkspace;
  verification: SnapshotVerification;
}

/**
 * 从不可变项目快照创建隔离实验工作区。
 *
 * 步骤:
 * 1. 用 `verifyProjectSnapshot` 校验快照完整性
 * 2. 用 `createExperimentDatabase` 创建物理隔离的 Dexie 实例
 * 3. 用 `restoreProjectSnapshot` 将快照记录恢复到实验库
 *
 * 任何步骤失败都会清理已创建的 Dexie 实例,避免残留。
 *
 * @param bundle 完整项目快照
 * @param experimentId 实验 ID,用于命名实验库(将做安全过滤)
 */
export async function loadProjectSnapshotIntoExperiment(
  bundle: SupportedProjectSnapshotBundle,
  experimentId: string,
): Promise<LoadSnapshotResult> {
  const verification = await verifyProjectSnapshot(bundle);
  if (!verification.valid) {
    throw new Error(`项目快照校验失败,无法创建实验工作区:${verification.issues.join("; ")}`);
  }

  const db = createExperimentDatabase(experimentId);
  try {
    await restoreProjectSnapshot(bundle, db);
  } catch (error) {
    // 恢复失败时清理已创建的实验库,避免残留
    try {
      await db.delete();
    } catch {
      // 忽略清理失败,抛出原始错误
    }
    throw error;
  }

  const workspace: ExperimentWorkspace = {
    db,
    experimentId,
    projectId: bundle.sourceProjectId,
    baseSnapshotId: bundle.snapshotId,
    baseSnapshotHash: bundle.manifest.snapshotHash,
    close: async () => {
      await db.close();
    },
    delete: async () => {
      await db.delete();
    },
  };

  return { workspace, verification };
}

/**
 * 在实验工作区中重新捕获快照,用于校验实验库当前状态。
 *
 * 不修改任何数据,只读捕获。可用于实验结束后导出候选前的状态确认。
 *
 * @param reason 快照原因,默认 "manual"(用于信息标注,不影响行为)
 */
export async function recaptureExperimentSnapshot(
  workspace: ExperimentWorkspace,
  reason: import("./project-snapshot").SnapshotReason = "manual",
): Promise<ProjectSnapshotBundle> {
  const { captureProjectSnapshot } = await import("./project-snapshot");
  return captureProjectSnapshot(workspace.db, workspace.projectId, reason);
}

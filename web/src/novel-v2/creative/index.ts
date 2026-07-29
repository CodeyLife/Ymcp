/**
 * V2 创意执行模块（Postgres 版）统一导出。
 *
 * 设计依据：AGENTS.md + Phase B-2 创意执行模块。
 *
 * 模块结构：
 * - run-manager：CreativeRun 生命周期（create/get/list/pause/resume/cancel/updateRunStatusFromWork）
 * - work-item：CreativeWorkItem 状态机（enqueue/get/list/start/accept/revise/retry/recover/fail/attachArtifact）
 * - review-gate：审核门禁（submitReview/listReviews/evaluateReviewGate/checkGate）
 * - command-router：命令路由（executeCreativeCommand + defaultReviewer）
 * - snapshot：run 快照查询（getRunSnapshot）
 *
 * 与 v1 的区别：v1 用 IndexedDB/Dexie 在客户端管理状态，v2 全部用 Postgres 表，
 * 事件溯源（creative_run_events），幂等性基于 idempotencyKey。
 *
 * 类型契约：所有类型从 ../protocol 导入，本模块不定义新类型。
 */
export type {
  CreativeRun,
  CreativeRunMode,
  CreativeRunPolicy,
  CreativeRunStatus,
  CreativeWorkItem,
  CreativeWorkKind,
  CreativeWorkStatus,
  CreativeReview,
  CreativeReviewInput,
  CreativeReviewGate,
  CreativeCommand,
  CreativeActionResult,
  CreativeRunSnapshot,
} from "../protocol";

export {
  createCreativeRun,
  getCreativeRun,
  listCreativeRuns,
  pauseCreativeRun,
  resumeCreativeRun,
  cancelCreativeRun,
  updateRunStatusFromWork,
} from "./run-manager";

export {
  enqueueCreativeWork,
  getWorkItem,
  listWorkItems,
  startWork,
  acceptWork,
  reviseWork,
  retryWork,
  recoverWork,
  failWork,
  attachArtifact,
} from "./work-item";

export {
  submitReview,
  listReviews,
  evaluateReviewGate,
  checkGate,
} from "./review-gate";

export {
  executeCreativeCommand,
  defaultReviewer,
} from "./command-router";

export {
  getRunSnapshot,
} from "./snapshot";

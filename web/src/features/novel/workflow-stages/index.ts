import { registerApprovalHandler, registerStageHandler } from "../workflow-stages";
import { blueprintStageHandler } from "./blueprint-stage";
import { blueprintApprovalHandler } from "./blueprint-approval";
import { commitStageHandler } from "./commit-stage";
import { contextStageHandler } from "./context-stage";
import { deterministicCheckStageHandler } from "./deterministic-check-stage";
import { draftStageHandler } from "./draft-stage";
import { factApprovalHandler } from "./fact-approval";
import { factExtractionStageHandler } from "./fact-extraction-stage";
import { manuscriptApprovalHandler } from "./manuscript-approval";
import { reviewStageHandler } from "./review-stage";
import { revisionStageHandler } from "./revision-stage";

/**
 * 注册所有内置 stage 与 approval handler。
 * 在模块加载时执行，workflow.ts 通过 import "./workflow-stages/index" 触发。
 */
export function registerAllHandlers(): void {
  // 执行类 stage（advanceChapterWorkflow 调度）
  registerStageHandler(contextStageHandler);
  registerStageHandler(blueprintStageHandler);
  registerStageHandler(draftStageHandler);
  registerStageHandler(deterministicCheckStageHandler);
  registerStageHandler(reviewStageHandler);
  registerStageHandler(revisionStageHandler);
  registerStageHandler(factExtractionStageHandler);
  registerStageHandler(commitStageHandler);

  // 审批类 stage（approveWorkflowStage 调度）
  registerApprovalHandler(blueprintApprovalHandler);
  registerApprovalHandler(manuscriptApprovalHandler);
  registerApprovalHandler(factApprovalHandler);
}

// 模块加载时自动注册
registerAllHandlers();

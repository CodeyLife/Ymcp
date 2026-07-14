import type {
  AgentRun,
  AIProposal,
  ManuscriptDocument,
  NovelAgentRole,
  StoryProject,
  WorkflowArtifact,
  WorkflowRun,
  WorkflowStage,
} from "./types";

/**
 * 产物输入类型：与 workflow.ts 中的 ArtifactInput 定义保持一致。
 * 独立定义以避免 workflow-stages.ts 与 workflow.ts 的运行时循环依赖。
 */
export type ArtifactInput = Omit<
  WorkflowArtifact,
  "id" | "schemaVersion" | "revision" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy" | "deletedAt"
>;

/**
 * Stage 执行上下文：注入 run/project/document 与所有工具函数，便于单元测试时 mock。
 */
export interface StageContext {
  run: WorkflowRun;
  project: StoryProject;
  document: ManuscriptDocument;
  saveArtifact: (run: WorkflowRun, input: ArtifactInput) => Promise<WorkflowArtifact>;
  latestArtifact: (runId: string, kinds: WorkflowArtifact["kind"][]) => Promise<WorkflowArtifact | undefined>;
  transition: (
    run: WorkflowRun,
    stage: WorkflowStage,
    status?: WorkflowRun["status"],
    changes?: Partial<WorkflowRun>,
  ) => Promise<WorkflowRun>;
  createAgentRecord: (params: {
    run: WorkflowRun;
    role: NovelAgentRole;
    goal: string;
    skillRefs: string[];
  }) => Promise<{ project: StoryProject; agent: AgentRun }>;
  finishAgent: (
    agent: AgentRun,
    params: { promptHash: string; usage?: { inputTokens: number; outputTokens: number }; artifactId?: string },
  ) => Promise<void>;
  failAgent: (agent: AgentRun, error: unknown) => Promise<void>;
  createApprovalProposal: (
    run: WorkflowRun,
    artifact: WorkflowArtifact,
    operation: string,
    title: string,
  ) => Promise<AIProposal>;
}

/**
 * Stage 执行结果。
 * - run：更新后的 WorkflowRun（已通过 transition 写入数据库）
 * - continueLoop：false 时跳出调度器循环（如进入 waiting-approval）
 */
export interface StageResult {
  run: WorkflowRun;
  continueLoop?: boolean;
}

/**
 * Stage handler 接口：每个 stage 实现独立的 execute 方法。
 */
export interface StageHandler {
  stage: WorkflowStage;
  execute(ctx: StageContext): Promise<StageResult>;
}

/**
 * Approval 上下文：审批 handler 所需的依赖。
 */
export interface ApprovalContext {
  run: WorkflowRun;
  transition: StageContext["transition"];
  saveArtifact: StageContext["saveArtifact"];
}

/**
 * Approval handler 接口：处理人工审批门禁（蓝图/正文/事实）。
 * 返回的 WorkflowRun 已经通过 transition 更新，并由调度器决定是否继续推进。
 */
export interface ApprovalHandler {
  stage: WorkflowStage;
  approve(ctx: ApprovalContext, params: { approved: boolean; feedback?: string; manuscriptChangeIds?: string[] }): Promise<WorkflowRun>;
}

/**
 * Stage handler 注册表：调度器通过 currentStage 查找对应 handler。
 */
export const STAGE_HANDLERS = new Map<WorkflowStage, StageHandler>();

/**
 * Approval handler 注册表：approveWorkflowStage 通过 currentStage 查找对应 handler。
 */
export const APPROVAL_HANDLERS = new Map<WorkflowStage, ApprovalHandler>();

export function registerStageHandler(handler: StageHandler): void {
  STAGE_HANDLERS.set(handler.stage, handler);
}

export function registerApprovalHandler(handler: ApprovalHandler): void {
  APPROVAL_HANDLERS.set(handler.stage, handler);
}

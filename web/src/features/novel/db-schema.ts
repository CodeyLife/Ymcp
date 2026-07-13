/** 新小说工作区不读取旧数据库，版本只描述当前结构。 */
export const DB_VERSION = 4;

/**
 * 数据记录版本（写入 recordBase.schemaVersion）。
 * 与 DB_VERSION 解耦：记录版本跟踪单条数据的字段语义，数据库版本跟踪表结构。
 */
export const RECORD_SCHEMA_VERSION = 4;

export const V4_STORES: Record<string, string> = {
  projects: "id, updatedAt, status, *genre",
  architectures: "id, projectId, status, updatedAt",
  entities: "id, projectId, kind, name, updatedAt, *tags, [projectId+kind]",
  relations: "id, projectId, fromEntityId, toEntityId, relationType",
  outlineNodes: "id, projectId, parentId, kind, order, status, [projectId+status]",
  scenes: "id, projectId, chapterId, order, status, [projectId+chapterId]",
  documents: "id, projectId, order, status, updatedAt, branch, [projectId+status]",
  revisions: "id, projectId, documentId, createdAt, branch",
  plotThreads: "id, projectId, kind, status, priority",
  foreshadowing: "id, projectId, status, urgency, targetNodeId",
  timelineEvents: "id, projectId, storyDate, narrativeOrder, *participantIds",
  snapshots: "id, projectId, createdAt",
  contextPackets: "id, projectId, createdAt, task",
  proposals: "id, projectId, targetId, projectGenerationRunId, status, createdAt, operation",
  agentRuns: "id, projectId, status, createdAt",
  projectGenerationRuns: "id, projectId, status, currentStage, updatedAt, [projectId+status]",
  operations: "id, projectId, operationId, logicalClock, syncStatus, idempotencyKey",
  conflicts: "id, projectId, status, entityId, [projectId+status]",
  skills: "id, skillId, projectId, source, category, enabled, [projectId+skillId]",
  projectSkills: "id, projectId, skillId, enabled, [projectId+skillId]",
  workflowDefinitions: "id, workflowId, projectId, builtin",
  workflowRuns: "id, projectId, workflowId, targetDocumentId, status, currentStage, updatedAt",
  workflowArtifacts: "id, projectId, workflowRunId, stage, kind, createdAt",
  qualityReports: "id, projectId, workflowRunId, artifactId, iteration, passed, createdAt",
  factCandidates: "id, projectId, workflowRunId, status, targetTable, targetId",
  preferenceSignals: "id, projectId, sourceType, category, createdAt",
  tasteProfiles: "id, projectId, status, updatedAt",
  embeddings: "id, projectId, targetTable, targetId, model, updatedAt, [projectId+targetTable]",
};

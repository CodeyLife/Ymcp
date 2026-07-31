import { createHash, randomUUID } from "node:crypto";
import type { Artifact, ChapterMemory, MemoryClaim, SkillProvider } from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { ModelRoutingSnapshot } from "../model-routing";
import type { ObjectStoreAdapter } from "../object-store";
import type { MemoryIndex } from "../qdrant-memory";
import { NovelPostgresRepository } from "../postgres-repository";
import { extractFactsWithStats } from "../fact-extraction";
import { buildChapterMemoryProjection, chapterMemoryAsClaim, generateChapterMemoryOutput } from "../chapter-memory";
export { ChapterStateRebuildConflictError, HISTORICAL_CHAPTER_REBUILD_REQUIRES_CASCADE } from "./chapter-state-rebuild-conflict";

export interface RebuildCommittedChapterStateResult {
  projectId: string;
  documentId: string;
  revisionId: string;
  factArtifactId: string;
  activatedClaims: MemoryClaim[];
  removedClaimIds: string[];
  chapterMemory: ChapterMemory;
}

export class ChapterStateRebuildService {
  constructor(private readonly deps: {
    repository: NovelPostgresRepository;
    objects: ObjectStoreAdapter;
    model: ModelGateway;
    skillProvider: SkillProvider;
    memoryIndex?: MemoryIndex;
    routingSnapshot?: ModelRoutingSnapshot;
  }) {}

  async rebuildCommittedChapterState(projectId: string, documentId: string, actorId: string): Promise<RebuildCommittedChapterStateResult> {
    if (!actorId.trim()) throw new Error("actorId 必填");
    const source = await this.deps.repository.getFinalDocumentContentRef(projectId, documentId);
    if (!source) throw new Error("章节不存在");
    if (source.status !== "final" || !source.sourceRevisionId || !source.objectKey || !source.contentHash) throw new Error("只能重建已有正式 revision 的章节状态");
    await this.deps.repository.assertChapterStateRebuildHead(projectId, documentId, source.sourceRevisionId);

    const text = await this.deps.objects.getText(source.objectKey);
    const workflowId = `chapter-state-rebuild:${documentId}:${randomUUID()}`;
    const factArtifact: Artifact = {
      id: randomUUID(),
      projectId,
      taskId: `${workflowId}:facts`,
      attemptId: `${workflowId}:facts:attempt-1`,
      kind: "fact-extraction",
      contentHash: source.contentHash,
      objectKey: source.objectKey,
      baseRevision: source.revision,
      fingerprint: createHash("sha256").update(`${source.sourceRevisionId}:${source.contentHash}:${workflowId}`).digest("hex"),
      structuredData: { origin: "committed-chapter-state-rebuild", sourceArtifactId: source.artifactId, documentId, revisionId: source.sourceRevisionId, workflowId, actorId },
      createdAt: Date.now(),
    };
    const extractionContext = await this.deps.repository.getFactExtractionContext(projectId, source.narrativeOrder - 1);
    const skills = (await this.deps.skillProvider.list(projectId))
      .filter((skill) => skill.enabled && skill.applicableTasks.includes("memory-maintenance") && !!skill.promptSections["fact-extraction"]?.trim())
      .map((skill) => ({ skillId: skill.skillId, promptSections: skill.promptSections }));
    const extracted = await extractFactsWithStats({
      projectId,
      artifact: factArtifact,
      text,
      model: this.deps.model,
      existingClaimsDigest: extractionContext.claimsDigest,
      existingContentHashes: extractionContext.contentHashes,
      existingClaimsIndex: extractionContext.claimsIndex,
      narrativeOrder: source.narrativeOrder,
      routingSnapshot: this.deps.routingSnapshot,
      workflowRunId: workflowId,
      taskId: factArtifact.taskId,
      skills,
    });
    const chapterMemoryOutput = extracted.chapterMemory ?? await generateChapterMemoryOutput({
      projectId,
      documentId,
      revisionId: source.sourceRevisionId,
      narrativeOrder: source.narrativeOrder,
      text,
      artifact: factArtifact,
      model: this.deps.model,
      routingSnapshot: this.deps.routingSnapshot,
      workflowRunId: workflowId,
      taskId: `${factArtifact.taskId}:chapter-memory`,
    }, { repository: this.deps.repository });

    await this.deps.repository.recordFactExtraction({ projectId, artifact: factArtifact, claims: extracted.claims, lifecycleStatus: "staged", documentId, workflowId, narrativeOrder: source.narrativeOrder });
    await this.deps.repository.recordFactApprovalPolicy({ projectId, artifactId: factArtifact.id, workflowId });
    const chapterMemory = buildChapterMemoryProjection({ projectId, documentId, revisionId: source.sourceRevisionId, narrativeOrder: source.narrativeOrder }, chapterMemoryOutput);
    const claimSwap = await this.deps.repository.applyCommittedChapterStateRebuild({
      projectId,
      documentId,
      revisionId: source.sourceRevisionId,
      factArtifactId: factArtifact.id,
      actorId,
      artifact: factArtifact,
      narrativeOrder: source.narrativeOrder,
      narrativeElements: extracted.narrativeElements,
      payoffMoments: extracted.payoffMoments,
      chapterMemory,
    });

    let rollupClaim: MemoryClaim | undefined;
    try {
      rollupClaim = await this.deps.repository.refreshChapterMemoryRollup(projectId, source.narrativeOrder);
    } catch (error) {
      await this.recordProjectionFailure(projectId, source.sourceRevisionId, "chapter-memory-rollup", error);
    }
    if (this.deps.memoryIndex) {
      try {
        if (claimSwap.removedClaimIds.length) await this.deps.memoryIndex.deleteClaims?.(projectId, claimSwap.removedClaimIds);
        await this.deps.memoryIndex.upsertClaims(projectId, [
          ...claimSwap.activatedClaims,
          chapterMemoryAsClaim(chapterMemory),
          ...(rollupClaim ? [rollupClaim] : []),
        ]);
      } catch (error) {
        await this.recordProjectionFailure(projectId, source.sourceRevisionId, "memory-index", error);
      }
    }
    return { projectId, documentId, revisionId: source.sourceRevisionId, factArtifactId: factArtifact.id, chapterMemory, ...claimSwap };
  }

  private async recordProjectionFailure(projectId: string, revisionId: string, projectionType: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[chapter-state-rebuild] ${projectionType} 投影失败，可从 PostgreSQL 重建：${message}`);
    await this.deps.repository.recordProjectionFailure({
      projectId,
      projectionType: `chapter-state-rebuild:${projectionType}`,
      aggregateId: revisionId,
      payload: { revisionId },
      error: message,
    }).catch((recordError) => console.warn(`[chapter-state-rebuild] 投影失败记录写入失败：${(recordError as Error).message}`));
  }
}

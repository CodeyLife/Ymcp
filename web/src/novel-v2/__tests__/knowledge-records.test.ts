import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact, MemoryClaim } from "../protocol";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("V2 formal knowledge records", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-knowledge-${randomUUID().slice(0, 8)}`;
  const skillId = `test-knowledge-skill-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Knowledge Test");
      available = true;
    } catch (error) {
      console.warn(`[knowledge-records.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteKnowledgeRecord(projectId, "skills", skillId).catch(() => undefined);
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("covers planning, worldview, character, relation, timeline, fact and skill CRUD through one audited boundary", async () => {
    if (!available) return;
    const planning = await repository.upsertKnowledgeRecord(projectId, "planning", { name: "第一卷规划", payload: { objective: "建立主冲突" } });
    const worldview = await repository.upsertKnowledgeRecord(projectId, "worldview", { name: "力量规则", payload: { rule: "使用力量需要代价" } });
    const character = await repository.upsertKnowledgeRecord(projectId, "characters", { name: "林岚", payload: { motivation: "寻找失踪的兄长" } });
    const mentor = await repository.upsertKnowledgeRecord(projectId, "characters", { name: "导师", payload: { role: "mentor" } });
    const relation = await repository.upsertKnowledgeRecord(projectId, "relations", { subjectId: character.id, predicate: "信任", objectId: mentor.id });
    const timeline = await repository.upsertKnowledgeRecord(projectId, "timeline", { narrativeTime: 3, eventType: "discovery", content: { summary: "发现密信" } });
    const fact = await repository.upsertKnowledgeRecord(projectId, "facts", { subjectId: character.id, predicate: "持有", objectValue: { item: "密信" }, truthStatus: "objective", confidence: 1 });
    await repository.upsertKnowledgeRecord(projectId, "skills", { id: skillId, version: "1.0.0", capabilities: ["drafting"], applicableTasks: ["drafting"], promptSections: { drafting: "保持人物知识边界。" }, enabled: true });

    expect((await repository.listKnowledgeRecords(projectId, "planning")).some((row) => row.id === planning.id)).toBe(true);
    expect((await repository.listKnowledgeRecords(projectId, "worldview")).some((row) => row.id === worldview.id)).toBe(true);
    expect((await repository.listKnowledgeRecords(projectId, "relations")).some((row) => row.id === relation.id)).toBe(true);
    expect((await repository.listKnowledgeRecords(projectId, "timeline")).some((row) => row.id === timeline.id)).toBe(true);
    expect((await repository.listKnowledgeRecords(projectId, "facts")).some((row) => row.id === fact.id)).toBe(true);
    expect((await repository.listKnowledgeRecords(projectId, "skills")).some((row) => row.id === skillId)).toBe(true);

    const audit = await repository.pool.query("SELECT action FROM audit_records WHERE project_id=$1 AND action='knowledge.upsert'", [projectId]);
    expect(audit.rowCount).toBeGreaterThanOrEqual(8);
  });

  it("keeps candidate facts out of retrieval until an audited approval", async () => {
    if (!available) return;
    const artifact: Artifact = { id: `fact-artifact-${randomUUID()}`, projectId, taskId: "facts", attemptId: "facts:1", kind: "fact-extraction", contentHash: randomUUID(), objectKey: "test/facts", baseRevision: 0, fingerprint: randomUUID(), structuredData: {}, createdAt: Date.now() };
    await repository.recordArtifact(artifact);
    const claim: MemoryClaim = { id: `claim-${randomUUID()}`, projectId, kind: "episodic", title: "未决密信", content: "林岚可能持有一封来源不明的密信", subjectRefs: ["lin-lan"], knowledgeScope: "author", authority: "candidate", confidence: 0.8, sourceRevisionIds: [], contentHash: randomUUID(), supersedes: [], predicate: "持有" };
    await repository.recordMemoryClaims({ projectId, claims: [claim], sourceArtifactId: artifact.id });

    const request = { projectId, facets: [{ kind: "fact" as const, query: "未决密信", required: true }] };
    expect((await repository.searchMemory(request)).some((item) => item.id === claim.id)).toBe(false);
    expect((await repository.listFactCandidates(projectId)).map((item) => item.id)).toContain(claim.id);
    const extractionContext = await repository.getFactExtractionContext(projectId);
    expect(extractionContext.claimsIndex.get("lin-lan|持有")).toContain(claim.id);

    await repository.decideFactCandidate({ projectId, claimId: claim.id, actorId: "test-author", decision: "approve" });
    expect((await repository.searchMemory(request)).some((item) => item.id === claim.id)).toBe(true);
    expect((await repository.listFactCandidates(projectId)).some((item) => item.id === claim.id)).toBe(false);
    const audit = await repository.pool.query("SELECT 1 FROM audit_records WHERE project_id=$1 AND aggregate_id=$2 AND action='fact-candidate.approve'", [projectId, claim.id]);
    expect(audit.rowCount).toBe(1);
  });
});

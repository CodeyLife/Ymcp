import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("foreshadowing narrative visibility", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-foreshadowing-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Foreshadowing Test");
      available = true;
    } catch (error) {
      console.warn(`[foreshadowing-order.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("shows only known past foreshadowing when a narrative cutoff is active", async () => {
    if (!available) return;
    const documentId = `document-${randomUUID()}`;
    const contentHash = `content-${randomUUID()}`;
    const revisionIds = ["past", "future", "unknown"].map((label) => `${label}-revision-${randomUUID()}`);
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order) VALUES($1,$2,$3,1)", [documentId, projectId, "测试章节"]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [contentHash, `test/${contentHash}`]);
    for (let index = 0; index < revisionIds.length; index += 1) {
      await repository.pool.query(
        "INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,$4,0,$5)",
        [revisionIds[index], projectId, documentId, index + 1, contentHash],
      );
    }
    await repository.pool.query(
      `INSERT INTO foreshadowing(id,project_id,planted_revision_id,status,payload,narrative_order)
       VALUES($1,$4,$6,'open',$5,3),($2,$4,$7,'open',$5,8),($3,$4,$8,'open',$5,NULL)`,
      [`past-${randomUUID()}`, `future-${randomUUID()}`, `unknown-${randomUUID()}`, projectId, { description: "测试伏笔" }, ...revisionIds],
    );
    await repository.pool.query(
      `INSERT INTO promises(id,project_id,statement,source_revision_id,status,payload,narrative_order)
       VALUES($1,$4,'过去承诺',$6,'open',$5,3),($2,$4,'未来承诺',$7,'open',$5,8),($3,$4,'未知承诺',$8,'open',$5,NULL)`,
      [`past-promise-${randomUUID()}`, `future-promise-${randomUUID()}`, `unknown-promise-${randomUUID()}`, projectId, { promiser: "甲", promisee: "乙" }, ...revisionIds],
    );
    const relationPast = `relation-past-${randomUUID()}`;
    const relationFuture = `relation-future-${randomUUID()}`;
    await repository.pool.query(
      "INSERT INTO entities(id,project_id,kind,name) VALUES($1,$3,'character','甲'),($2,$3,'character','乙')",
      [`entity-a-${randomUUID()}`, `entity-b-${randomUUID()}`, projectId],
    );
    const entityIds = await repository.pool.query<{ id: string }>("SELECT id FROM entities WHERE project_id=$1 ORDER BY id DESC LIMIT 2", [projectId]);
    await repository.pool.query(
      `INSERT INTO relations(id,project_id,subject_id,predicate,object_id,valid_from,source_revision_id)
       VALUES($1,$3,$4,'同行',$5,3,$6),($2,$3,$4,'同行',$5,8,$7)`,
      [relationPast, relationFuture, projectId, entityIds.rows[0].id, entityIds.rows[1].id, revisionIds[0], revisionIds[1]],
    );
    const graphAtFive = await repository.searchGraphMemory({ projectId, narrativeCutoff: 5, povCharacterId: entityIds.rows[0].id, facets: [{ kind: "relation", query: "同行", required: false }] });
    expect(graphAtFive.map((item) => item.id)).toEqual([`graph:${relationPast}`]);

    const visibleAtFive = await repository.getOpenForeshadowingAndPromises(projectId, 5);
    const visibleWithoutCutoff = await repository.getOpenForeshadowingAndPromises(projectId);

    expect(visibleAtFive.foreshadowings.map((item) => item.plantedRevisionId)).toEqual([revisionIds[0]]);
    expect(visibleWithoutCutoff.foreshadowings.map((item) => item.plantedRevisionId).sort()).toEqual([...revisionIds].sort());
    expect(visibleAtFive.promises).toEqual([expect.objectContaining({ statement: "过去承诺", promiser: "甲", promisee: "乙", sourceRevisionId: revisionIds[0] })]);
    expect(visibleWithoutCutoff.promises.map((item) => item.statement).sort()).toEqual(["过去承诺", "未来承诺", "未知承诺"].sort());

    const snapshot = await repository.recordNarrativeStateSnapshot({
      projectId,
      documentId,
      revisionId: revisionIds[0],
      narrativeOrder: 5,
      chapterMemory: {
        id: `memory-${randomUUID()}`,
        projectId,
        documentId,
        revisionId: revisionIds[0],
        narrativeRange: { start: 5, end: 5 },
        summary: "甲与乙确认继续同行，但尚未处理过去的承诺。",
        keyEvents: ["双方继续同行"],
        characterStates: [{ characterId: "甲", stateSnapshot: "仍然保持戒备" }],
        unresolvedThreads: ["承诺是否兑现"],
        fingerprint: "memory-fingerprint",
        createdAt: Date.now(),
      },
    });
    const pinned = await repository.getNarrativeStatePinnedClaims({ projectId, narrativeCutoff: 5, povCharacterId: "甲" });
    expect(snapshot.openPromises.map((item) => item.statement)).toEqual(["过去承诺"]);
    expect(pinned).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: snapshot.id, matchedFacets: expect.arrayContaining(["thread", "entity"]) }),
      expect.objectContaining({ id: `${snapshot.id}:pov:甲`, knowledgeScope: { characterId: "甲" } }),
    ]));
    const stateClaim = pinned.find((item) => item.id === snapshot.id);
    expect(stateClaim?.content).not.toContain("测试伏笔");
    expect(stateClaim?.content).not.toContain("过去承诺");
  });
});

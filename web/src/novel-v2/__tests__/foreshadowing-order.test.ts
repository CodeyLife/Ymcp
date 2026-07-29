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

    const visibleAtFive = await repository.getOpenForeshadowingAndPromises(projectId, 5);
    const visibleWithoutCutoff = await repository.getOpenForeshadowingAndPromises(projectId);

    expect(visibleAtFive.foreshadowings.map((item) => item.plantedRevisionId)).toEqual([revisionIds[0]]);
    expect(visibleWithoutCutoff.foreshadowings.map((item) => item.plantedRevisionId).sort()).toEqual([...revisionIds].sort());
  });
});

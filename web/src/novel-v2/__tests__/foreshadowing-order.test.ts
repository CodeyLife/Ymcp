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
    await repository.pool.query(
      `INSERT INTO foreshadowing(id,project_id,planted_revision_id,status,payload,narrative_order)
       VALUES($1,$4,'past-artifact','open',$5,3),($2,$4,'future-artifact','open',$5,8),($3,$4,'unknown-artifact','open',$5,NULL)`,
      [`past-${randomUUID()}`, `future-${randomUUID()}`, `unknown-${randomUUID()}`, projectId, { description: "测试伏笔" }],
    );

    const visibleAtFive = await repository.getOpenForeshadowingAndPromises(projectId, 5);
    const visibleWithoutCutoff = await repository.getOpenForeshadowingAndPromises(projectId);

    expect(visibleAtFive.foreshadowings.map((item) => item.plantedRevisionId)).toEqual(["past-artifact"]);
    expect(visibleWithoutCutoff.foreshadowings.map((item) => item.plantedRevisionId).sort()).toEqual(["future-artifact", "past-artifact", "unknown-artifact"]);
  });
});

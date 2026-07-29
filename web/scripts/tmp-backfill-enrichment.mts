// 临时：回填章节角色富化（character enrichment）
// 背景：FK bug 导致 ch1-5 enrichCharacters 失败/缺失（仅 3 个 entity、2 条 relation），
// 苏晚意（女主）/院长/江南男子 等关键角色未入库。FK 修复已部署后，用此脚本对已定稿章节
// 重跑 enrichCharactersFromChapter，幂等 UPSERT 恢复角色图谱。
// 用法: node --import tsx scripts/tmp-backfill-enrichment.mts [startOrd] [endOrd]
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { createRuntimeModelGateway } from "../src/novel-v2/model-runtime";
import { ContentObjectStore } from "../src/novel-v2/object-store";
import { enrichCharactersFromChapter } from "../src/novel-v2/character-enrichment";

const PROJECT_ID = process.env.PROJECT_ID ?? "spirit-logic-v4-20260729";
const startOrd = Number(process.argv[2] ?? "1");
const endOrd = Number(process.argv[3] ?? "5");

const repository = new NovelPostgresRepository();
const objectStore = new ContentObjectStore();
const { gateway } = await createRuntimeModelGateway(repository);

// 取所有定稿章节（按 narrative_order）
const docs = await repository.pool.query<{
  id: string; title: string; status: string; narrative_order: number; current_revision_id: string;
}>(
  `SELECT id, title, status, narrative_order, current_revision_id
   FROM manuscript_documents WHERE project_id=$1 AND status='final'
     AND narrative_order BETWEEN $2 AND $3 ORDER BY narrative_order`,
  [PROJECT_ID, startOrd, endOrd],
);

console.log(`回填范围: 第${startOrd}-${endOrd}章，定稿文档 ${docs.rowCount} 个\n`);

let totalEntities = 0;
let totalRelations = 0;
let totalClaims = 0;

for (const doc of docs.rows) {
  const ref = await repository.getFinalDocumentContentRef(PROJECT_ID, doc.id);
  if (!ref?.objectKey) {
    console.log(`#${doc.narrative_order} ${doc.title}: 无定稿正文，跳过`);
    continue;
  }
  const text = await objectStore.getText(ref.objectKey);
  const artifact = await repository.getArtifactById(PROJECT_ID, ref.artifactId);
  if (!artifact) {
    console.log(`#${doc.narrative_order} ${doc.title}: artifact ${ref.artifactId} 未找到，跳过`);
    continue;
  }
  const revisionId = doc.current_revision_id;
  if (!revisionId) {
    console.log(`#${doc.narrative_order} ${doc.title}: 无 current_revision_id，跳过`);
    continue;
  }

  console.log(`#${doc.narrative_order} ${doc.title} (${text.length}字) → 富化中...`);
  try {
    const result = await enrichCharactersFromChapter(
      {
        projectId: PROJECT_ID,
        documentId: doc.id,
        revisionId,
        narrativeOrder: doc.narrative_order,
        text,
        artifact,
        model: gateway,
        workflowRunId: `backfill-enrichment-${doc.id}`,
        taskId: `backfill:ch${doc.narrative_order}:enrichment`,
      },
      { repository, objects: objectStore },
    );
    console.log(`  ✓ entities=${result.entityUpdates} relations=${result.relationRecords} knowledgeClaims=${result.knowledgeClaims.length}`);
    for (const d of result.deltas) {
      console.log(`    - ${d.characterId}: voice=${d.voiceAnchor.sentenceLength?.slice(0, 40) ?? "-"} rels=${d.relationDeltas.length}`);
    }
    totalEntities += result.entityUpdates;
    totalRelations += result.relationRecords;
    totalClaims += result.knowledgeClaims.length;
  } catch (error) {
    console.log(`  ✗ 失败: ${(error as Error).message}`);
  }
}

console.log(`\n=== 回填汇总 ===`);
console.log(`  entities 更新: ${totalEntities}`);
console.log(`  relations 新增: ${totalRelations}`);
console.log(`  knowledge claims: ${totalClaims}`);

// 最终校验
const ents = await repository.pool.query<{ name: string }>(
  `SELECT name FROM entities WHERE project_id=$1 AND kind='character' ORDER BY name`,
  [PROJECT_ID],
);
console.log(`\n=== 当前角色 entities (${ents.rowCount}) ===`);
for (const r of ents.rows) console.log(`  ${r.name}`);

const rels = await repository.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM relations WHERE project_id=$1`, [PROJECT_ID]);
console.log(`relations 总数: ${rels.rows[0].n}`);

await repository.close();

import pg from "pg";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectId = argument("--project");
const repairArcId = argument("--repair-arc");
const replanArcId = argument("--replan-arc");
const apply = process.argv.includes("--apply");

if (!projectId || !repairArcId || !replanArcId) {
  throw new Error("用法: node --import tsx scripts/repair-story-arc-order.ts --project <id> --repair-arc <id> --replan-arc <id> [--apply]");
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp",
});

try {
  const before = await pool.query(
    `SELECT d.narrative_order,d.title,a.id AS arc_id,a.execution_status
     FROM manuscript_documents d
     LEFT JOIN chapters c ON c.document_id=d.id
     LEFT JOIN arcs a ON a.id=c.arc_id
     WHERE d.project_id=$1
     ORDER BY d.narrative_order`,
    [projectId],
  );
  console.table(before.rows);
  if (!apply) {
    console.log("Dry run only. Re-run with --apply after verifying the target project and arc IDs.");
    process.exitCode = 0;
  } else {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const repairArc = await client.query<{ execution_status: string }>(
        "SELECT execution_status FROM arcs WHERE id=$1 AND project_id=$2 FOR UPDATE",
        [repairArcId, projectId],
      );
      const replanArc = await client.query<{ execution_status: string }>(
        "SELECT execution_status FROM arcs WHERE id=$1 AND project_id=$2 FOR UPDATE",
        [replanArcId, projectId],
      );
      if (!repairArc.rowCount || !replanArc.rowCount) throw new Error("修复目标故事弧不属于指定项目");

      const generatedReplanDocuments = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM chapters c JOIN manuscript_documents d ON d.id=c.document_id
         WHERE c.arc_id=$1 AND (d.status<>'planned' OR d.current_revision_id IS NOT NULL)`,
        [replanArcId],
      );
      if (Number(generatedReplanDocuments.rows[0]?.count ?? 0) > 0) throw new Error("待重规划故事弧已产生正文，拒绝自动重排");

      await client.query("DELETE FROM chapters WHERE project_id=$1 AND arc_id IN (SELECT id FROM arcs WHERE project_id=$1 AND execution_status='abandoned') AND document_id IS NULL", [projectId]);

      await client.query("UPDATE manuscript_documents SET narrative_order=narrative_order+100000,updated_at=now() WHERE project_id=$1 AND narrative_order BETWEEN 16 AND 20", [projectId]);
      await client.query("UPDATE manuscript_documents SET narrative_order=narrative_order-5,updated_at=now() WHERE project_id=$1 AND narrative_order BETWEEN 11 AND 15", [projectId]);
      await client.query("UPDATE manuscript_documents SET narrative_order=narrative_order-100005,updated_at=now() WHERE project_id=$1 AND narrative_order BETWEEN 100016 AND 100020", [projectId]);

      await client.query(`UPDATE chapters
        SET ordinal=ordinal+100000,
            payload=jsonb_set(payload,'{index}',to_jsonb((payload->>'index')::integer+100000),true),
            updated_at=now()
        WHERE project_id=$1 AND arc_id=$2 AND ordinal BETWEEN 16 AND 20`, [projectId, replanArcId]);
      await client.query(`UPDATE chapters
        SET ordinal=ordinal-5,
            payload=jsonb_set(payload,'{index}',to_jsonb(ordinal-5),true),
            updated_at=now()
        WHERE project_id=$1 AND arc_id=$2 AND ordinal BETWEEN 11 AND 15`, [projectId, repairArcId]);
      await client.query(`UPDATE chapters
        SET ordinal=ordinal-100005,
            payload=jsonb_set(payload,'{index}',to_jsonb((payload->>'index')::integer-100005),true),
            updated_at=now()
        WHERE project_id=$1 AND arc_id=$2 AND ordinal BETWEEN 100016 AND 100020`, [projectId, replanArcId]);

      await client.query("UPDATE story_arc_batches SET start_chapter_index=start_chapter_index+100000,end_chapter_index=end_chapter_index+100000,payload=jsonb_set(payload,'{startChapterIndex}',to_jsonb((payload->>'startChapterIndex')::integer+100000),true),updated_at=now() WHERE project_id=$1 AND arc_id=$2", [projectId, replanArcId]);
      await client.query(`UPDATE story_arc_batches b
        SET start_chapter_index=span.start_order,
            end_chapter_index=span.end_order,
            payload=jsonb_set(payload,'{startChapterIndex}',to_jsonb(span.start_order),true),
            updated_at=now()
        FROM (
          SELECT arc_id,MIN(ordinal)::integer AS start_order,MAX(ordinal)::integer AS end_order
          FROM chapters
          WHERE project_id=$1 AND arc_id=$2
          GROUP BY arc_id
        ) span
        WHERE b.project_id=$1 AND b.arc_id=$2`, [projectId, repairArcId]);
      await client.query("UPDATE story_arc_batches SET start_chapter_index=start_chapter_index-100005,end_chapter_index=end_chapter_index-100005,payload=jsonb_set(payload,'{startChapterIndex}',to_jsonb((payload->>'startChapterIndex')::integer-100005),true),updated_at=now() WHERE project_id=$1 AND arc_id=$2", [projectId, replanArcId]);

      await client.query("UPDATE chapter_memories SET narrative_start=CASE WHEN narrative_start BETWEEN 11 AND 15 THEN narrative_start-5 ELSE narrative_start END,narrative_end=CASE WHEN narrative_end BETWEEN 11 AND 15 THEN narrative_end-5 ELSE narrative_end END WHERE project_id=$1", [projectId]);
      await client.query("UPDATE payoff_curve SET narrative_order=narrative_order-5 WHERE project_id=$1 AND narrative_order BETWEEN 11 AND 15", [projectId]);
      await client.query("UPDATE foreshadowing SET narrative_order=narrative_order-5 WHERE project_id=$1 AND narrative_order BETWEEN 11 AND 15", [projectId]);
      await client.query("UPDATE facts SET narrative_start=CASE WHEN narrative_start BETWEEN 11 AND 15 THEN narrative_start-5 ELSE narrative_start END,narrative_end=CASE WHEN narrative_end BETWEEN 11 AND 15 THEN narrative_end-5 ELSE narrative_end END WHERE project_id=$1", [projectId]);
      await client.query("UPDATE memory_claims SET narrative_start=CASE WHEN narrative_start BETWEEN 11 AND 15 THEN narrative_start-5 ELSE narrative_start END,narrative_end=CASE WHEN narrative_end BETWEEN 11 AND 15 THEN narrative_end-5 ELSE narrative_end END WHERE project_id=$1", [projectId]);
      await client.query("UPDATE arcs SET execution_status='active',completed_at=NULL,updated_at=now() WHERE id=$1 AND project_id=$2", [repairArcId, projectId]);
      await client.query("UPDATE arcs SET planning_status='stale',context_fingerprint=NULL,updated_at=now(),payload=payload || jsonb_build_object('replanReason','章节索引与长篇节奏修复后需重建蓝图') WHERE id=$1 AND project_id=$2", [replanArcId, projectId]);

      await client.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'repair-script','story-arc.narrative-order-repaired','story-arc',$2,$3)", [projectId, repairArcId, { repairArcId, replanArcId, repairedRange: [11, 15, 6, 10], replannedRange: [16, 20, 11, 15] }]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}

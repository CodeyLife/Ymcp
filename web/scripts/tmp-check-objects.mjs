// 临时：检查 ch1-5 的 object_key 在 disk / MinIO 的存在性
import pg from "pg";
import { existsSync } from "node:fs";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

const pool = new pg.Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
const s3 = new S3Client({
  region: "us-east-1", endpoint: "http://127.0.0.1:9000", forcePathStyle: true,
  credentials: { accessKeyId: "ymcp", secretAccessKey: "ymcp-minio-local" },
});
const BUCKET = "ymcp-novel";

const r = await pool.query(
  `SELECT d.narrative_order, d.title, mr.content_hash, cb.object_key, cb.byte_length
   FROM manuscript_documents d
   JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
   LEFT JOIN content_blobs cb ON cb.content_hash=mr.content_hash
   WHERE d.project_id='spirit-logic-v4-20260729' ORDER BY d.narrative_order`,
);

console.log("ord | title | disk | minio | byte_length");
for (const row of r.rows) {
  const key = row.object_key;
  const diskPath = `.data/objects/${key?.replaceAll("/", "\\")}`;
  const onDisk = key ? existsSync(diskPath) : false;
  let onMinio = false;
  if (key) {
    try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); onMinio = true; }
    catch { onMinio = false; }
  }
  console.log(`#${row.narrative_order} | ${row.title} | ${onDisk ? "✓" : "✗"} | ${onMinio ? "✓" : "✗"} | ${row.byte_length ?? "-"} | key=${key}`);
}

// 也检查 manuscript_documents 是否有 plain_text / content_html 列
const cols = await pool.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='manuscript_documents' AND column_name IN ('plain_text','content_html','plaintext','content','body')`,
);
console.log(`\nmanuscript_documents 文本列: ${cols.rows.map((c) => c.column_name).join(", ") || "(无)"}`);

await pool.end();

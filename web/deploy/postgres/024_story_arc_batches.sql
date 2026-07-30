CREATE TABLE IF NOT EXISTS story_arc_batches (
  id TEXT PRIMARY KEY,
  arc_id TEXT NOT NULL REFERENCES arcs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  batch_index INTEGER NOT NULL,
  start_chapter_index INTEGER NOT NULL,
  end_chapter_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'generating',
  entry_fingerprint TEXT NOT NULL DEFAULT '',
  source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(arc_id,batch_index)
);

ALTER TABLE chapters ADD COLUMN IF NOT EXISTS batch_id TEXT REFERENCES story_arc_batches(id) ON DELETE SET NULL;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS batch_index INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS story_arc_batches_arc_index ON story_arc_batches(arc_id,batch_index);
CREATE INDEX IF NOT EXISTS chapters_batch_ordinal ON chapters(batch_id,ordinal);

INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,entry_fingerprint,source_artifact_id,payload,approved_at)
SELECT 'batch:'||a.id||':1',a.id,a.project_id,1,1,GREATEST(1,count(c.id)),'approved',COALESCE(a.context_fingerprint,''),a.blueprint_artifact_id,
  jsonb_build_object('migrated',true),a.approved_at
FROM arcs a LEFT JOIN chapters c ON c.arc_id=a.id
GROUP BY a.id
ON CONFLICT(arc_id,batch_index) DO NOTHING;

UPDATE chapters c SET batch_id='batch:'||c.arc_id||':1',batch_index=1 WHERE batch_id IS NULL;

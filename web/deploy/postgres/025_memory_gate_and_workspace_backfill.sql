ALTER TABLE workflow_run_summaries
  ADD COLUMN IF NOT EXISTS metrics JSONB NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO chapter_production_specs(document_id,project_id,chapter_goal,blueprint,blueprint_fingerprint,source_artifact_id)
SELECT d.id,d.project_id,COALESCE(ch.payload->>'chapterPurpose',''),COALESCE(ch.payload,'{}'::jsonb),COALESCE(a.fingerprint,''),ch.source_artifact_id
FROM manuscript_documents d
LEFT JOIN chapters ch ON ch.document_id=d.id
LEFT JOIN artifacts a ON a.id=ch.source_artifact_id
ON CONFLICT(document_id) DO NOTHING;

UPDATE manuscript_revisions mr SET retention_class='rolling',expires_at=now()+interval '30 days'
FROM manuscript_documents d
WHERE mr.document_id=d.id AND mr.id<>d.current_revision_id AND mr.retention_class='workflow';

CREATE TABLE IF NOT EXISTS memory_gate_states (
  project_id TEXT PRIMARY KEY REFERENCES novel_projects(id) ON DELETE CASCADE,
  consecutive_critical_misses INTEGER NOT NULL DEFAULT 0,
  last_missing_facets TEXT[] NOT NULL DEFAULT '{}',
  last_workflow_id TEXT,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rebuild_requested_at TIMESTAMPTZ,
  CHECK (consecutive_critical_misses >= 0)
);

CREATE INDEX IF NOT EXISTS memory_gate_states_degraded
  ON memory_gate_states(consecutive_critical_misses DESC, last_checked_at DESC)
  WHERE consecutive_critical_misses > 0;

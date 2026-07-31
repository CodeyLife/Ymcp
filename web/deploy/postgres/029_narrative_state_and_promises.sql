-- Durable narrative ledger and promise visibility metadata.
ALTER TABLE promises ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}';
ALTER TABLE promises ADD COLUMN IF NOT EXISTS narrative_order INTEGER;

UPDATE promises p
SET narrative_order = d.narrative_order
FROM manuscript_revisions r
JOIN manuscript_documents d ON d.id = r.document_id AND d.project_id = r.project_id
WHERE p.source_revision_id = r.id
  AND p.project_id = r.project_id
  AND p.narrative_order IS NULL;

CREATE INDEX IF NOT EXISTS idx_promises_project_order
  ON promises(project_id, narrative_order);

CREATE TABLE IF NOT EXISTS narrative_state_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES manuscript_documents(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES manuscript_revisions(id) ON DELETE CASCADE,
  narrative_order INTEGER NOT NULL,
  payload JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, revision_id)
);

CREATE INDEX IF NOT EXISTS idx_narrative_state_project_order
  ON narrative_state_snapshots(project_id, narrative_order DESC);

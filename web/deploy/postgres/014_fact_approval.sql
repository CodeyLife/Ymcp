ALTER TABLE memory_claims
  ADD COLUMN IF NOT EXISTS source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_by TEXT,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS memory_claims_pending_approval
  ON memory_claims(project_id, created_at DESC)
  WHERE authority = 'candidate';

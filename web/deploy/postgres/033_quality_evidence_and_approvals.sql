ALTER TABLE arcs ADD COLUMN IF NOT EXISTS review_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL;
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS review_fingerprint TEXT;

CREATE TABLE IF NOT EXISTS approval_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject','revise','abandon')),
  actor_source TEXT NOT NULL CHECK (actor_source IN ('interactive-web','automation')),
  actor_id TEXT NOT NULL,
  unresolved_issue_fingerprints TEXT[] NOT NULL DEFAULT '{}',
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_evidence_workflow ON approval_evidence(workflow_id,created_at DESC);

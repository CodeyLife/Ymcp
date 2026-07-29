ALTER TABLE reviews ADD COLUMN IF NOT EXISTS dimension_scores JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE manuscript_revisions ADD COLUMN IF NOT EXISTS retention_class TEXT NOT NULL DEFAULT 'workflow';
ALTER TABLE manuscript_revisions ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE manuscript_revisions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS chapter_production_specs (
  document_id TEXT PRIMARY KEY REFERENCES manuscript_documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  chapter_goal TEXT NOT NULL DEFAULT '',
  blueprint JSONB NOT NULL DEFAULT '{}'::jsonb,
  blueprint_fingerprint TEXT NOT NULL DEFAULT '',
  source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chapter_review_snapshots (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE REFERENCES manuscript_documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES manuscript_revisions(id) ON DELETE SET NULL,
  reviewed_content_hash TEXT NOT NULL,
  artifact_fingerprint TEXT NOT NULL,
  source_workflow_id TEXT,
  verdict TEXT NOT NULL,
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  overall_score REAL,
  dimension_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewer_roles TEXT[] NOT NULL DEFAULT '{}',
  reviewed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chapter_review_snapshot_issues (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES chapter_review_snapshots(id) ON DELETE CASCADE,
  issue_fingerprint TEXT NOT NULL,
  dimension TEXT,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  evidence_quote TEXT NOT NULL DEFAULT '',
  paragraph INTEGER,
  revision_ranges JSONB NOT NULL DEFAULT '[]'::jsonb,
  rule TEXT,
  suggestion TEXT,
  source_roles TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(snapshot_id, issue_fingerprint)
);

CREATE TABLE IF NOT EXISTS workflow_run_summaries (
  workflow_run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES manuscript_documents(id) ON DELETE SET NULL,
  workflow_type TEXT NOT NULL,
  final_status TEXT NOT NULL,
  final_stage TEXT,
  elapsed_ms BIGINT,
  failure_summary TEXT,
  cleaned_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chapter_review_snapshot_project ON chapter_review_snapshots(project_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS manuscript_revisions_expiry ON manuscript_revisions(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_run_summaries_cleanup ON workflow_run_summaries(cleaned_at, completed_at);

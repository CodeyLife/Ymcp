ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS config_revision TEXT;
ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS protocol TEXT;
ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS candidates JSONB NOT NULL DEFAULT '[]';
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS conversation_policy TEXT NOT NULL DEFAULT 'stateless';
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS config_revision TEXT;
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS model_provenance JSONB;

CREATE TABLE IF NOT EXISTS model_invocations (
  id BIGSERIAL PRIMARY KEY,
  workflow_run_id TEXT,
  task_id TEXT,
  purpose TEXT NOT NULL,
  config_revision TEXT NOT NULL,
  candidate_index INTEGER NOT NULL,
  executor TEXT NOT NULL,
  profile_id TEXT,
  protocol TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  prompt_fingerprint TEXT NOT NULL,
  response_id TEXT,
  error_category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_model_invocations_purpose_created ON model_invocations(purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS model_tasks (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  config_revision TEXT NOT NULL,
  candidate_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  work_package JSONB NOT NULL,
  result JSONB,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_model_tasks_pending ON model_tasks(status, created_at);

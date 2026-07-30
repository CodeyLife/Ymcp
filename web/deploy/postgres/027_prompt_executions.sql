CREATE TABLE IF NOT EXISTS prompt_executions (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT,
  task_id TEXT,
  purpose TEXT NOT NULL,
  candidate_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  prompt_fingerprint TEXT NOT NULL,
  response_fingerprint TEXT,
  prompt_object_key TEXT NOT NULL,
  response_object_key TEXT,
  context_manifest JSONB,
  error_category TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prompt_executions_workflow_created ON prompt_executions(workflow_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prompt_executions_expiry ON prompt_executions(expires_at);

ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS provider_input_tokens INTEGER;
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS provider_output_tokens INTEGER;
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS estimated_input_tokens INTEGER;
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS estimated_output_tokens INTEGER;
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS usage_source TEXT NOT NULL DEFAULT 'provider';

CREATE TABLE IF NOT EXISTS projection_failures (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  projection_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(projection_type, aggregate_id)
);

CREATE TABLE IF NOT EXISTS runtime_services (
  service_id TEXT PRIMARY KEY,
  service_type TEXT NOT NULL,
  status TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_services_heartbeat ON runtime_services(service_type, heartbeat_at DESC);

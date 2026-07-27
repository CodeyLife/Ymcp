CREATE TABLE IF NOT EXISTS novel_projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  current_revision BIGINT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manuscript_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  narrative_order BIGINT NOT NULL,
  pov_character_id TEXT,
  current_revision_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, narrative_order)
);
CREATE INDEX IF NOT EXISTS manuscript_documents_project_order ON manuscript_documents(project_id, narrative_order);

CREATE TABLE IF NOT EXISTS novel_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id),
  source TEXT NOT NULL,
  objective TEXT NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS preflight_plans (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES novel_intents(id),
  project_id TEXT NOT NULL REFERENCES novel_projects(id),
  payload JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  subject_refs TEXT[] NOT NULL DEFAULT '{}',
  narrative_start BIGINT,
  narrative_end BIGINT,
  knowledge_scope JSONB NOT NULL,
  authority TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_revision_ids TEXT[] NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  supersedes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_claims_project_kind ON memory_claims(project_id, kind);
CREATE INDEX IF NOT EXISTS memory_claims_subjects ON memory_claims USING GIN(subject_refs);

CREATE TABLE IF NOT EXISTS skill_definitions (
  skill_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  applicable_tasks TEXT[] NOT NULL DEFAULT '{}',
  required_memory_kinds TEXT[] NOT NULL DEFAULT '{}',
  conflicts TEXT[] NOT NULL DEFAULT '{}',
  quality_gates TEXT[] NOT NULL DEFAULT '{}',
  prompt_sections JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_bundles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id),
  preflight_id TEXT NOT NULL REFERENCES preflight_plans(id),
  payload JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_bundles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id),
  preflight_id TEXT NOT NULL REFERENCES preflight_plans(id),
  payload JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_blueprints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id),
  intent_id TEXT NOT NULL REFERENCES novel_intents(id),
  preflight_id TEXT NOT NULL REFERENCES preflight_plans(id),
  memory_bundle_id TEXT NOT NULL REFERENCES memory_bundles(id),
  skill_bundle_id TEXT NOT NULL REFERENCES skill_bundles(id),
  payload JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES novel_projects(id),
  temporal_workflow_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGSERIAL PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox_events(id) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS content_blobs (
  content_hash TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  byte_length BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS manuscript_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES manuscript_documents(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL,
  base_revision BIGINT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES content_blobs(content_hash),
  artifact_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(document_id, revision)
);
CREATE INDEX IF NOT EXISTS manuscript_revisions_document ON manuscript_revisions(document_id, revision DESC);
CREATE TABLE IF NOT EXISTS manuscript_blocks (
  revision_id TEXT NOT NULL REFERENCES manuscript_revisions(id) ON DELETE CASCADE,
  block_index INTEGER NOT NULL,
  block_type TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES content_blobs(content_hash),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(revision_id, block_index)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  object_key TEXT,
  base_revision BIGINT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  reviewer_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  verdict TEXT NOT NULL,
  artifact_fingerprint TEXT NOT NULL,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage_ledger (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  task_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, key)
);

CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, title TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}', UNIQUE(project_id, id));
CREATE TABLE IF NOT EXISTS volumes (id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, title TEXT NOT NULL, ordinal INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS arcs (id TEXT PRIMARY KEY, volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, title TEXT NOT NULL, ordinal INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chapters (id TEXT PRIMARY KEY, arc_id TEXT REFERENCES arcs(id) ON DELETE SET NULL, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, title TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'planned');
CREATE TABLE IF NOT EXISTS scenes (id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, summary TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, subject_id TEXT NOT NULL, predicate TEXT NOT NULL, object_id TEXT NOT NULL, valid_from BIGINT, valid_to BIGINT, source_revision_id TEXT);
CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, subject_id TEXT, predicate TEXT NOT NULL, object_value JSONB NOT NULL, truth_status TEXT NOT NULL DEFAULT 'candidate', confidence REAL NOT NULL DEFAULT 0, narrative_start BIGINT, narrative_end BIGINT);
CREATE TABLE IF NOT EXISTS fact_sources (fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE, revision_id TEXT NOT NULL, evidence JSONB NOT NULL DEFAULT '{}', PRIMARY KEY(fact_id, revision_id));
CREATE TABLE IF NOT EXISTS timeline_events (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, narrative_time BIGINT NOT NULL, event_type TEXT NOT NULL, content JSONB NOT NULL DEFAULT '{}', source_revision_id TEXT);
CREATE TABLE IF NOT EXISTS character_knowledge (character_id TEXT NOT NULL, fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE, known_at BIGINT, certainty REAL NOT NULL DEFAULT 1, PRIMARY KEY(character_id, fact_id));
CREATE TABLE IF NOT EXISTS plot_threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', payload JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS foreshadowing (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, thread_id TEXT REFERENCES plot_threads(id), planted_revision_id TEXT, payoff_revision_id TEXT, status TEXT NOT NULL DEFAULT 'open', payload JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS promises (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, thread_id TEXT REFERENCES plot_threads(id), statement TEXT NOT NULL, source_revision_id TEXT, status TEXT NOT NULL DEFAULT 'open');
CREATE TABLE IF NOT EXISTS payoffs (id TEXT PRIMARY KEY, promise_id TEXT NOT NULL REFERENCES promises(id) ON DELETE CASCADE, revision_id TEXT, evidence JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS task_attempts (id TEXT PRIMARY KEY, workflow_run_id TEXT, task_id TEXT NOT NULL, lease_owner TEXT, lease_expires_at TIMESTAMPTZ, heartbeat_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'pending', payload JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS quality_gates (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, artifact_id TEXT, gate_type TEXT NOT NULL, passed BOOLEAN NOT NULL, evidence JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS commit_records (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, revision_id TEXT NOT NULL, artifact_fingerprint TEXT NOT NULL, base_revision BIGINT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_records (id BIGSERIAL PRIMARY KEY, project_id TEXT REFERENCES novel_projects(id) ON DELETE CASCADE, actor TEXT NOT NULL, action TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS memory_snapshots (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, revision BIGINT NOT NULL, payload JSONB NOT NULL, fingerprint TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS retrieval_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, query JSONB NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS context_manifests (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, retrieval_run_id TEXT REFERENCES retrieval_runs(id), source_revision_ids TEXT[] NOT NULL DEFAULT '{}', token_budget INTEGER NOT NULL, truncation_reason TEXT, fingerprint TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, project_id TEXT REFERENCES novel_projects(id) ON DELETE CASCADE, name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS skill_versions (skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE, version TEXT NOT NULL, content TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(skill_id, version));
CREATE TABLE IF NOT EXISTS skill_bindings (project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE, skill_id TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(project_id, skill_id));
CREATE TABLE IF NOT EXISTS provider_configs (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, capabilities TEXT[] NOT NULL DEFAULT '{}', config JSONB NOT NULL DEFAULT '{}', enabled BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS model_routes (task_class TEXT PRIMARY KEY, primary_provider_id TEXT NOT NULL, fallback_provider_id TEXT, budget JSONB NOT NULL DEFAULT '{}');

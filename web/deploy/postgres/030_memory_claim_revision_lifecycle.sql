ALTER TABLE memory_claims
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS source_document_id TEXT REFERENCES manuscript_documents(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source_workflow_id TEXT,
  ADD COLUMN IF NOT EXISTS identity_hash TEXT,
  ADD COLUMN IF NOT EXISTS value_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_claims_lifecycle_status_check'
  ) THEN
    ALTER TABLE memory_claims
      ADD CONSTRAINT memory_claims_lifecycle_status_check
      CHECK (lifecycle_status IN ('staged', 'active'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS memory_claim_sources (
  claim_id TEXT NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES manuscript_documents(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES manuscript_revisions(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  workflow_id TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'staged' CHECK (lifecycle_status IN ('staged', 'active')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS memory_claims_active_project
  ON memory_claims(project_id, created_at DESC)
  WHERE lifecycle_status = 'active';
CREATE INDEX IF NOT EXISTS memory_claims_active_identity
  ON memory_claims(project_id, identity_hash)
  WHERE lifecycle_status = 'active' AND identity_hash IS NOT NULL;
-- Historical claims used several legacy hash algorithms and were never covered
-- by a database uniqueness contract. Restrict the new contract to claims that
-- carry the canonical identity/value pair introduced by this migration.
CREATE UNIQUE INDEX IF NOT EXISTS memory_claims_project_content_scope
  ON memory_claims(project_id, content_hash, (md5(knowledge_scope::text)))
  WHERE identity_hash IS NOT NULL AND value_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_claim_sources_revision
  ON memory_claim_sources(project_id, document_id, revision_id);

-- Backfill provenance through fact-artifact -> manuscript-artifact -> committed revision.
WITH mapped AS (
  SELECT mc.id AS claim_id, mc.project_id, mr.document_id, mr.id AS revision_id,
         mc.source_artifact_id AS artifact_id
  FROM memory_claims mc
  JOIN artifacts a ON a.id = mc.source_artifact_id
  LEFT JOIN artifacts source ON source.id = a.payload->>'sourceArtifactId'
  JOIN manuscript_revisions mr ON mr.artifact_id = COALESCE(source.id, a.id)
  WHERE mc.source_artifact_id IS NOT NULL
)
INSERT INTO memory_claim_sources(claim_id, project_id, document_id, revision_id, artifact_id, lifecycle_status)
SELECT claim_id, project_id, document_id, revision_id, artifact_id, 'active'
FROM mapped
ON CONFLICT (claim_id, artifact_id) DO UPDATE SET
  document_id = EXCLUDED.document_id,
  revision_id = EXCLUDED.revision_id,
  lifecycle_status = EXCLUDED.lifecycle_status;

UPDATE memory_claims mc
SET source_document_id = source.document_id,
    source_revision_ids = ARRAY[source.revision_id]
FROM memory_claim_sources source
WHERE source.claim_id = mc.id AND source.lifecycle_status = 'active';

-- A rewritten chapter owns only its current revision. Remove obsolete revision sources.
DELETE FROM memory_claim_sources source
USING manuscript_documents document
WHERE source.document_id = document.id
  AND source.revision_id IS NOT NULL
  AND source.revision_id <> document.current_revision_id;

DELETE FROM memory_claims claim
WHERE claim.source_document_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM memory_claim_sources source
    WHERE source.claim_id = claim.id AND source.lifecycle_status = 'active'
  );

UPDATE memory_claims claim
SET source_revision_ids = COALESCE((
      SELECT array_agg(DISTINCT source.revision_id) FILTER (WHERE source.revision_id IS NOT NULL)
      FROM memory_claim_sources source
      WHERE source.claim_id = claim.id AND source.lifecycle_status = 'active'
    ), '{}'),
    lifecycle_status = CASE WHEN EXISTS (
      SELECT 1 FROM memory_claim_sources source
      WHERE source.claim_id = claim.id AND source.lifecycle_status = 'active'
    ) OR claim.source_document_id IS NULL THEN 'active' ELSE 'staged' END;

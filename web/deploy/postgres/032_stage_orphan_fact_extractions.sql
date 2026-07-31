-- Old extraction attempts that never gained committed provenance must not keep
-- the default active status assigned before lifecycle tracking existed.
UPDATE memory_claims claim
SET lifecycle_status = 'staged'
FROM artifacts artifact
WHERE artifact.id = claim.source_artifact_id
  AND artifact.kind = 'fact-extraction'
  AND NOT EXISTS (
    SELECT 1
    FROM memory_claim_sources source
    WHERE source.claim_id = claim.id
      AND source.lifecycle_status = 'active'
  );

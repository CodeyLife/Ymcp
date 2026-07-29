ALTER TABLE memory_claims
  ADD COLUMN IF NOT EXISTS predicate TEXT;

CREATE INDEX IF NOT EXISTS memory_claims_subject_predicate
  ON memory_claims(project_id, predicate)
  WHERE predicate IS NOT NULL AND authority <> 'rejected';

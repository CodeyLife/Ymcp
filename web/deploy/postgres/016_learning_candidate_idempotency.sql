-- A learning assessment may be replayed by Temporal, but it must produce one
-- durable craft-rule candidate. The JSON field is retained for provenance;
-- this index promotes assessmentId to an idempotency key at the storage layer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_craft_rule_candidate_learning_assessment
  ON craft_rule_candidates(project_id, (learning_source->>'assessmentId'))
  WHERE learning_source IS NOT NULL
    AND learning_source ? 'assessmentId';

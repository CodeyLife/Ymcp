-- Chapter-derived claims used to be persisted with a NULL narrative range and
-- were therefore treated as globally visible. Rebuild their introduction order
-- from active revision provenance. Foundation/project claims remain NULL/global.
WITH claim_orders AS (
  SELECT source.claim_id, MIN(document.narrative_order) AS narrative_order
  FROM memory_claim_sources source
  JOIN manuscript_documents document
    ON document.id = source.document_id
   AND document.project_id = source.project_id
  WHERE source.lifecycle_status = 'active'
  GROUP BY source.claim_id
)
UPDATE memory_claims claim
SET narrative_start = claim_orders.narrative_order,
    narrative_end = claim_orders.narrative_order
FROM claim_orders
WHERE claim.id = claim_orders.claim_id
  AND (
    claim.narrative_start IS DISTINCT FROM claim_orders.narrative_order
    OR claim.narrative_end IS DISTINCT FROM claim_orders.narrative_order
  );

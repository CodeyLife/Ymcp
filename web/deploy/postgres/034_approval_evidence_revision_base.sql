ALTER TABLE approval_evidence
  ADD COLUMN IF NOT EXISTS revision_base TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approval_evidence_revision_base_check'
  ) THEN
    ALTER TABLE approval_evidence
      ADD CONSTRAINT approval_evidence_revision_base_check
      CHECK (revision_base IS NULL OR revision_base IN ('current','previous'));
  END IF;
END $$;

ALTER TABLE content_blobs
  ADD COLUMN IF NOT EXISTS word_count BIGINT;

ALTER TABLE content_blobs
  ADD CONSTRAINT content_blobs_word_count_nonnegative
  CHECK (word_count IS NULL OR word_count >= 0);

DO $$
DECLARE
  experiment_schema TEXT;
BEGIN
  FOR experiment_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'experiment\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.content_blobs ADD COLUMN IF NOT EXISTS word_count BIGINT',
      experiment_schema
    );
  END LOOP;
END $$;

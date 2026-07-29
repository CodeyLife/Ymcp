-- Preserve the model's role-specific review score instead of reconstructing
-- quality from duplicate issue counts after the workflow has completed.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS score REAL;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS role TEXT;


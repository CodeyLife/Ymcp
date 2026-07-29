CREATE TABLE IF NOT EXISTS project_plan_sections (
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  work_item_id TEXT REFERENCES creative_work_items(id) ON DELETE SET NULL,
  source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  edit_revision BIGINT NOT NULL DEFAULT 0,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, task_key),
  CONSTRAINT project_plan_sections_status_check CHECK (
    status IN ('locked','ready','generating','awaiting-confirmation','approved','stale','failed')
  )
);

CREATE INDEX IF NOT EXISTS project_plan_sections_project_status
  ON project_plan_sections(project_id, status);

INSERT INTO project_plan_sections(
  project_id,task_key,work_item_id,source_artifact_id,status,payload,approved_at,created_at,updated_at
)
SELECT latest.project_id,latest.task_key,wi.id,latest.id,'approved',latest.payload,latest.created_at,latest.created_at,latest.created_at
FROM (
  SELECT DISTINCT ON (project_id,payload->>'taskKey')
    project_id,
    payload->>'taskKey' AS task_key,
    NULLIF(payload->>'workItemId','') AS work_item_id,
    id,
    payload,
    created_at
  FROM artifacts
  WHERE kind='foundation'
    AND payload->>'taskKey' IN (
      'project-positioning','architecture','characters','worldview','relations','plot-threads',
      'foreshadowing','timeline','story-control','plot-design','chapter-plan'
    )
    AND payload->>'pendingExternalTaskId' IS NULL
  ORDER BY project_id,payload->>'taskKey',created_at DESC
) latest
LEFT JOIN creative_work_items wi ON wi.id=latest.work_item_id
ON CONFLICT(project_id,task_key) DO NOTHING;

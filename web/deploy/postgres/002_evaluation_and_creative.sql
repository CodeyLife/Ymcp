-- V2 评估闭环 + 创意执行 schema 扩展
-- 依赖 001_novel_v2.sql（基础表已创建）
--
-- 设计依据：.trae/documents/v2-capability-expansion-plan.md Phase B-1/B-2
-- 所有表都 ON DELETE CASCADE 关联 novel_projects，项目删除时自动清理。

-- ===== 评估闭环 =====

-- 项目快照：完整捕获正式库地基数据，用于恢复实验 schema
CREATE TABLE IF NOT EXISTS project_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  head JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_snapshots_project ON project_snapshots(project_id, created_at DESC);

-- 实验工作区：Postgres schema 隔离的实验环境
CREATE TABLE IF NOT EXISTS experiment_workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  schema_name TEXT NOT NULL UNIQUE,
  base_snapshot_id TEXT NOT NULL REFERENCES project_snapshots(id),
  base_snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS experiment_workspaces_project ON experiment_workspaces(project_id, created_at DESC);

-- 实验期间迭代的 skill prompt
CREATE TABLE IF NOT EXISTS iterated_skills (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment_workspaces(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  before_prompt TEXT NOT NULL,
  after_prompt TEXT NOT NULL,
  rationale TEXT NOT NULL,
  triggered_by_issue_ids TEXT[] NOT NULL DEFAULT '{}',
  learning_mechanism TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS iterated_skills_experiment ON iterated_skills(experiment_id);

-- 候选包：实验产物归一化为可晋升的 bundle
CREATE TABLE IF NOT EXISTS candidate_bundles (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment_workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidate_bundles_experiment ON candidate_bundles(experiment_id);
CREATE INDEX IF NOT EXISTS candidate_bundles_project ON candidate_bundles(project_id, created_at DESC);

-- 晋升幂等 receipt：同一 candidateId 重复 promote 返回同一 receipt
CREATE TABLE IF NOT EXISTS promotion_receipts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promotion_receipts_project ON promotion_receipts(project_id, created_at DESC);

-- ===== 创意执行 =====

-- CreativeRun：多章节自动化创作 run
CREATE TABLE IF NOT EXISTS creative_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_runs_project ON creative_runs(project_id, created_at DESC);

-- CreativeWorkItem：run 内的具体工作项
CREATE TABLE IF NOT EXISTS creative_work_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES creative_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  task_key TEXT,
  target_id TEXT,
  instruction TEXT NOT NULL,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  artifact_refs TEXT[] NOT NULL DEFAULT '{}',
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_work_items_run ON creative_work_items(run_id, created_at);

ALTER TABLE creative_work_items ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES novel_projects(id) ON DELETE CASCADE;
UPDATE creative_work_items AS work
SET project_id = run.project_id
FROM creative_runs AS run
WHERE work.run_id = run.id AND work.project_id IS NULL;
ALTER TABLE creative_work_items ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS creative_work_items_project ON creative_work_items(project_id, created_at DESC);

-- CreativeReview：work item 的审核结果
CREATE TABLE IF NOT EXISTS creative_reviews (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES creative_work_items(id) ON DELETE CASCADE,
  subject_artifact_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  verdict TEXT NOT NULL,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_reviews_work_item ON creative_reviews(work_item_id, created_at DESC);

-- CreativeRunEvent：run 生命周期事件流
CREATE TABLE IF NOT EXISTS creative_run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES creative_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_run_events_run ON creative_run_events(run_id, created_at DESC);

-- V2 Craft Rule 候选演进 schema
-- 依赖 001_novel_v2.sql（novel_projects 已创建）+ 002_evaluation_and_creative.sql（creative_work_items / promotion_receipts 已创建）
--
-- 设计依据：AGENTS.md 架构阶段 + Phase B-2 craft-rule 模块。
-- 表 craft_rule_candidates 存储 skill/system-prompt 的候选变更，
-- 通过 evidence → review → promote → rollback 闭环迭代规则版本。
-- 与 v1 的区别：v1 用 IndexedDB（craft-rule-evolution.ts），v2 基于 Postgres。

-- Craft Rule 候选演进表
CREATE TABLE IF NOT EXISTS craft_rule_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('skill', 'system-prompt')),
  target_id TEXT NOT NULL,
  before_version TEXT NOT NULL,
  proposed_version TEXT NOT NULL,
  before_text TEXT NOT NULL,
  after_text TEXT NOT NULL,
  rationale TEXT NOT NULL,
  scope JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'evidencing', 'reviewing', 'promoted', 'rolled-back', 'rejected')),
  evidence_cases JSONB NOT NULL DEFAULT '[]',
  reviews JSONB NOT NULL DEFAULT '[]',
  learning_source JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_craft_rule_candidates_project ON craft_rule_candidates(project_id);
CREATE INDEX IF NOT EXISTS idx_craft_rule_candidates_target ON craft_rule_candidates(project_id, target_kind, target_id);

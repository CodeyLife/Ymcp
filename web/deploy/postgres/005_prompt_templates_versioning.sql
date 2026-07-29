-- V2 Prompt Templates 版本管理 schema
-- 依赖 001_novel_v2.sql（novel_projects 已创建）
--
-- 设计依据：AGENTS.md + v2-refactor-followup-plan.md C-2.7 system-prompt target 支持。
-- 表 prompt_templates 存储 system-prompt 模板（与 skill_definitions 平行），
-- 供 craft-rule 的 system-prompt target 进行版本演进（before/after 对比 + promote/rollback）。
--
-- 与 skill_definitions 的区别：
-- - skill_definitions.prompt_sections 是 JSONB（按 stage 分段的 prompt）
-- - prompt_templates.content 是纯文本（完整 system prompt）
-- - prompt_templates.stages 标记该 prompt 适用的 NovelStage

-- Prompt 模板表（与 skill_definitions 平行的版本管理）
CREATE TABLE IF NOT EXISTS prompt_templates (
  id TEXT PRIMARY KEY,                          -- 全局唯一主键（如 "pt-<projectId>-<templateId>"）
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,                    -- 项目内模板标识（如 "chapter-draft-system"）
  version TEXT NOT NULL DEFAULT '1.0.0',        -- 语义化版本号（与 skill_definitions.version 一致风格）
  content TEXT NOT NULL,                        -- 模板内容（纯文本 system prompt）
  stages TEXT[] NOT NULL DEFAULT '{}',          -- 适用 NovelStage（drafting/review/revision/fact-extraction 等）
  content_fingerprint TEXT,                     -- 内容指纹（SHA256，用于变更检测）
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_project ON prompt_templates(project_id);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_lookup ON prompt_templates(project_id, template_id, version);

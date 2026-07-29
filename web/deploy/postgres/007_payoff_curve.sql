-- Phase 3.2 爽点曲线追踪
-- 设计依据：改进计划 Phase 3.2 + AGENTS.md「reusable contracts over case-specific rules」
--
-- payoff_curve 表记录每章的爽点强度，用于：
-- 1. 蓝图编译时提示「最近 N 章无 achievement 型爽点，建议本章安排」
-- 2. reader-reviewer 审校时检查「连续 N 章无爽点，追更体验下降」
--
-- payoff_type 是通用爽感维度（非金手指/系统流特化）：
-- - achievement：成就型（突破、获得、达成目标）
-- - recognition：认可型（被肯定、被敬畏、地位提升）
-- - reversal：反转型（逆境翻盘、真相揭露、打脸）
-- - emotional：情感型（羁绊深化、虐心释放、温情时刻）
-- - mystery：悬疑型（谜团揭开、伏笔兑现、真相浮现）
--
-- intensity 1-5：1=轻描淡写，3=明显推进，5=高潮爆发
-- setup_revision_id 关联铺垫章节（可为空，表示无明确铺垫）

CREATE TABLE IF NOT EXISTS payoff_curve (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  narrative_order INT NOT NULL,
  payoff_type TEXT NOT NULL CHECK (payoff_type IN ('achievement', 'recognition', 'reversal', 'emotional', 'mystery')),
  intensity INT NOT NULL CHECK (intensity >= 1 AND intensity <= 5),
  setup_revision_id TEXT,
  payoff_description TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

-- 按项目 + 章节顺序查询（用于绘制爽点曲线）
CREATE INDEX IF NOT EXISTS idx_payoff_curve_project_order ON payoff_curve(project_id, narrative_order);

-- 按项目 + 爽点类型查询（用于检查某类型爽点的连续缺失）
CREATE INDEX IF NOT EXISTS idx_payoff_curve_project_type ON payoff_curve(project_id, payoff_type, narrative_order);

-- 按文档查询（用于章节级聚合）
CREATE INDEX IF NOT EXISTS idx_payoff_curve_document ON payoff_curve(document_id, narrative_order);

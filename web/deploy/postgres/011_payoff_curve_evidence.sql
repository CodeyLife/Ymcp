-- P2-G4: payoff_curve 补充 evidence / setup_description 列
-- 设计依据：AGENTS.md「root-cause analysis」——
-- FactExtractionOutput.payoffMoments 已要求 LLM 返回 evidence（正文逐字证据）
-- 和 setupDescription（铺垫描述），但 recordPayoffCurve 未落库，导致：
-- 1. reader-reviewer 审校时无法回溯爽点的正文依据，只能凭 description 判断
-- 2. 跨章铺垫映射丢失（setupDescription 记录了哪一章哪些事件铺垫了本爽点）
-- 3. learning 闭环无法用 evidence 做根因分析（只能看到症状描述）
--
-- 本迁移为 payoff_curve 表新增两列：
-- - evidence TEXT：正文逐字证据（NOT NULL，schema 已强制 LLM 返回）
-- - setup_description TEXT：铺垫描述（可为空，LLM 可能不返回）
--
-- 与 payoff_description 的区别：
-- - payoff_description：爽点内容的概括描述（"主角突破到金丹期"）
-- - evidence：正文中支撑该爽点的逐字引用（"丹田中金光大盛，一颗金丹缓缓凝聚..."）
-- - setup_description：铺垫该爽点的前置事件（"第 12 章获得的天材地宝在此刻炼化"）

ALTER TABLE payoff_curve ADD COLUMN IF NOT EXISTS evidence TEXT;
ALTER TABLE payoff_curve ADD COLUMN IF NOT EXISTS setup_description TEXT;

-- 已有历史记录的 evidence 回填为 payoff_description（避免 NOT NULL 约束破坏旧数据）
-- 注意：新列允许 NULL，不设 NOT NULL 约束，因为历史数据无 evidence，
-- 强制 NOT NULL 会导致迁移失败。recordPayoffCurve 写入新数据时会显式提供 evidence。
UPDATE payoff_curve SET evidence = payoff_description WHERE evidence IS NULL;

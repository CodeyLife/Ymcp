-- P0 #2: 让未兑现伏笔支持按叙事顺序过滤
-- 问题：getOpenForeshadowingAndPromises 接收 narrativeCutoff 但被 `void` 掉，
--       因为 foreshadowing 表没有 narrative_order 列，导致长篇后期审校会注入
--       "未来章节" 埋设的伏笔，造成剧透 / 逻辑污染。
-- 修复：补充 narrative_order 列，并在读取时按 narrativeCutoff 过滤
--       （narrative_order <= cutoff 的伏笔才对当前章节可见，供其兑现）。

ALTER TABLE foreshadowing ADD COLUMN IF NOT EXISTS narrative_order INTEGER;

-- 旧记录与同一次事实提取产生的 memory claim 共享 source artifact id；用其章节范围回填。
UPDATE foreshadowing AS f
SET narrative_order = source.narrative_order
FROM (
  SELECT project_id, source_artifact_id, MIN(narrative_start)::INTEGER AS narrative_order
  FROM memory_claims
  WHERE source_artifact_id IS NOT NULL AND narrative_start IS NOT NULL
  GROUP BY project_id, source_artifact_id
) AS source
WHERE f.project_id = source.project_id
  AND f.planted_revision_id = source.source_artifact_id
  AND f.narrative_order IS NULL;

CREATE INDEX IF NOT EXISTS idx_foreshadowing_project_order
  ON foreshadowing (project_id, narrative_order);

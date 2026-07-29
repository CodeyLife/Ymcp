-- Phase 3.3 题材通用差异化：skill_definitions 增加 applicable_genres 列
-- 设计依据：改进计划 Phase 3.3 + AGENTS.md「reusable contracts over case-specific rules」
--
-- applicable_genres 是题材匹配维度（不内置金手指/系统流特化枚举）：
-- - 留空数组表示题材无关（任何 genre 都适用）
-- - 非空数组表示仅适用于列出的 genre（如 ['玄幻','仙侠']）
-- - genre 字符串由调用方定义，craft rule 通过 learning 闭环沉淀题材相关规则
--
-- resolveSkillBundle 优先选择 applicable_genres 包含当前 genre 的 skill，
-- 但不强制——若无匹配 genre 的 skill，仍回退到题材无关的 skill。

ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS applicable_genres TEXT[] NOT NULL DEFAULT '{}';

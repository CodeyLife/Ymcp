-- P0-C1 修复（2026-07-27）：craft_rule_candidates 增加 applicable_genres 列
-- 设计依据：Phase 3.3 + AGENTS.md「reusable contracts over case-specific rules」
--
-- craft rule candidate 通过 learning 闭环沉淀题材相关规则，promote 时写入
-- skill_definitions.applicable_genres，让 resolveSkillBundle 能按 genre 匹配题材特化 skill。
--
-- applicable_genres 留空数组（NULL）表示题材无关；非空数组表示仅适用于列出的 genre。
-- 不内置金手指/系统流特化枚举——genre 字符串由调用方定义。

ALTER TABLE craft_rule_candidates ADD COLUMN IF NOT EXISTS applicable_genres TEXT[];

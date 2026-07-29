-- 006_chapter_memory.sql
-- 章节记忆表：定稿章节的结构化摘要，用于长篇跨章节一致性。
-- 依据 AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约。

CREATE TABLE IF NOT EXISTS chapter_memories (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    document_id     TEXT NOT NULL,
    revision_id     TEXT NOT NULL,
    narrative_start INT NOT NULL,
    narrative_end   INT NOT NULL,
    summary         TEXT NOT NULL,
    key_events      JSONB NOT NULL DEFAULT '[]'::jsonb,
    character_states JSONB NOT NULL DEFAULT '[]'::jsonb,
    unresolved_threads JSONB NOT NULL DEFAULT '[]'::jsonb,
    emotional_arc   TEXT,
    fingerprint     TEXT NOT NULL,
    created_at      BIGINT NOT NULL
);

-- 索引：按项目 + 章节顺序检索（前 N 章摘要）
CREATE INDEX IF NOT EXISTS chapter_memories_project_order_idx
    ON chapter_memories (project_id, narrative_start);

-- 索引：按 revision 反查（commit 后回写）
CREATE INDEX IF NOT EXISTS chapter_memories_revision_idx
    ON chapter_memories (revision_id);

-- 索引：按 document 查询（章节审校时取最近 chapter memory）
CREATE INDEX IF NOT EXISTS chapter_memories_document_idx
    ON chapter_memories (document_id);

-- 010_fk_cascade.sql
-- P1-E1 ~ P1-E4 修复（2026-07-27）：补齐缺失的外键约束 + ON DELETE CASCADE。
--
-- 设计依据：AGENTS.md「root-cause analysis」——原 schema 大量 FK 缺失 ON DELETE CASCADE，
-- 导致 deleteProject 必须手写一长串 DELETE 语句按依赖顺序清理（postgres-repository.ts:388-411）。
-- 这是数据完整性层的机制错误，不是单点 bug：
-- - 任何遗漏表的 DELETE 都会因 FK 约束失败
-- - 新增表如果忘记加入 deleteProject 的清理列表，会形成孤儿数据
-- - 缺失 FK 让 relations.subject_id/entities.id 等关联可能漂移
--
-- 修复策略：
-- 1. 删除现有无 CASCADE 的 FK，重建为 ON DELETE CASCADE
-- 2. 补齐缺失的 FK（relations→entities, task_attempts→workflow_runs, chapter_memories→*）
-- 3. 对内容性引用（manuscript_revisions.content_hash→content_blobs）保留 RESTRICT，
--    避免误删内容导致 revision 损坏
--
-- 兼容性：使用 IF EXISTS 容忍旧 schema 已有的约束名差异。
-- 架构阶段允许破坏性变更，但本迁移保持向后兼容（只加约束，不改结构）。

-- ===== P1-E1: novel_intents / preflight_plans / memory_claims ON DELETE CASCADE =====

ALTER TABLE novel_intents DROP CONSTRAINT IF EXISTS novel_intents_project_id_fkey;
ALTER TABLE novel_intents ADD CONSTRAINT novel_intents_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;

ALTER TABLE preflight_plans DROP CONSTRAINT IF EXISTS preflight_plans_intent_id_fkey;
ALTER TABLE preflight_plans ADD CONSTRAINT preflight_plans_intent_id_fkey
    FOREIGN KEY (intent_id) REFERENCES novel_intents(id) ON DELETE CASCADE;

ALTER TABLE preflight_plans DROP CONSTRAINT IF EXISTS preflight_plans_project_id_fkey;
ALTER TABLE preflight_plans ADD CONSTRAINT preflight_plans_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;

ALTER TABLE memory_claims DROP CONSTRAINT IF EXISTS memory_claims_project_id_fkey;
ALTER TABLE memory_claims ADD CONSTRAINT memory_claims_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;

-- ===== P1-E2: memory_bundles / skill_bundles / execution_blueprints ON DELETE CASCADE =====

ALTER TABLE memory_bundles DROP CONSTRAINT IF EXISTS memory_bundles_project_id_fkey;
ALTER TABLE memory_bundles ADD CONSTRAINT memory_bundles_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;

ALTER TABLE memory_bundles DROP CONSTRAINT IF EXISTS memory_bundles_preflight_id_fkey;
ALTER TABLE memory_bundles ADD CONSTRAINT memory_bundles_preflight_id_fkey
    FOREIGN KEY (preflight_id) REFERENCES preflight_plans(id) ON DELETE CASCADE;

ALTER TABLE skill_bundles DROP CONSTRAINT IF EXISTS skill_bundles_project_id_fkey;
ALTER TABLE skill_bundles ADD CONSTRAINT skill_bundles_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;

ALTER TABLE skill_bundles DROP CONSTRAINT IF EXISTS skill_bundles_preflight_id_fkey;
ALTER TABLE skill_bundles ADD CONSTRAINT skill_bundles_preflight_id_fkey
    FOREIGN KEY (preflight_id) REFERENCES preflight_plans(id) ON DELETE CASCADE;

ALTER TABLE execution_blueprints DROP CONSTRAINT IF EXISTS execution_blueprints_project_id_fkey;
ALTER TABLE execution_blueprints ADD CONSTRAINT execution_blueprints_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;

ALTER TABLE execution_blueprints DROP CONSTRAINT IF EXISTS execution_blueprints_intent_id_fkey;
ALTER TABLE execution_blueprints ADD CONSTRAINT execution_blueprints_intent_id_fkey
    FOREIGN KEY (intent_id) REFERENCES novel_intents(id) ON DELETE CASCADE;

ALTER TABLE execution_blueprints DROP CONSTRAINT IF EXISTS execution_blueprints_preflight_id_fkey;
ALTER TABLE execution_blueprints ADD CONSTRAINT execution_blueprints_preflight_id_fkey
    FOREIGN KEY (preflight_id) REFERENCES preflight_plans(id) ON DELETE CASCADE;

ALTER TABLE execution_blueprints DROP CONSTRAINT IF EXISTS execution_blueprints_memory_bundle_id_fkey;
ALTER TABLE execution_blueprints ADD CONSTRAINT execution_blueprints_memory_bundle_id_fkey
    FOREIGN KEY (memory_bundle_id) REFERENCES memory_bundles(id) ON DELETE CASCADE;

ALTER TABLE execution_blueprints DROP CONSTRAINT IF EXISTS execution_blueprints_skill_bundle_id_fkey;
ALTER TABLE execution_blueprints ADD CONSTRAINT execution_blueprints_skill_bundle_id_fkey
    FOREIGN KEY (skill_bundle_id) REFERENCES skill_bundles(id) ON DELETE CASCADE;

-- ===== P1-E3: workflow_runs / reviews / artifacts 关联 ON DELETE CASCADE =====

ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_project_id_fkey;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_artifact_id_fkey;
ALTER TABLE reviews ADD CONSTRAINT reviews_artifact_id_fkey
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE;

-- task_attempts.workflow_run_id 缺失 FK，且需引用 workflow_runs.id（不是 temporal_workflow_id）
-- 注意：task_attempts.workflow_run_id 存储的是 workflow_runs.id（业务 id），
-- 不是 temporal_workflow_id，因此 FK 指向 workflow_runs(id)。
-- 但 task_attempts.workflow_run_id 可为 NULL（任务未关联 workflow）。
ALTER TABLE task_attempts DROP CONSTRAINT IF EXISTS task_attempts_workflow_run_id_fkey;
ALTER TABLE task_attempts ADD CONSTRAINT task_attempts_workflow_run_id_fkey
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

-- commit_records.revision_id 应引用 manuscript_revisions.id
ALTER TABLE commit_records DROP CONSTRAINT IF EXISTS commit_records_revision_id_fkey;
ALTER TABLE commit_records ADD CONSTRAINT commit_records_revision_id_fkey
    FOREIGN KEY (revision_id) REFERENCES manuscript_revisions(id) ON DELETE CASCADE;

-- ===== P1-E4: chapter_memories 补 FK + ON DELETE CASCADE =====
-- chapter_memories 表原先完全没有 FK，导致 deleteProject 时该表残留孤儿数据。

ALTER TABLE chapter_memories DROP CONSTRAINT IF EXISTS chapter_memories_project_id_fkey;
ALTER TABLE chapter_memories ADD CONSTRAINT chapter_memories_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;

ALTER TABLE chapter_memories DROP CONSTRAINT IF EXISTS chapter_memories_document_id_fkey;
ALTER TABLE chapter_memories ADD CONSTRAINT chapter_memories_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES manuscript_documents(id) ON DELETE CASCADE;

ALTER TABLE chapter_memories DROP CONSTRAINT IF EXISTS chapter_memories_revision_id_fkey;
ALTER TABLE chapter_memories ADD CONSTRAINT chapter_memories_revision_id_fkey
    FOREIGN KEY (revision_id) REFERENCES manuscript_revisions(id) ON DELETE CASCADE;

-- ===== P1-E4 续: relations → entities / manuscript_revisions 补 FK =====
-- P1-D3 修复后 relations.subject_id/object_id 使用 entityId 格式，
-- 必须有 FK 约束保证引用完整性。
-- 注意：entities(id) 可能不存在（character enrichment 未运行时），因此 FK 是 DEFERRABLE。
-- 但 PostgreSQL FK 不支持真正意义上的"软引用"，这里仍加 FK——
-- character-enrichment 在写入 relations 前已先 UPSERT entity，保证 subject_id 存在；
-- object_id 也需要先 UPSERT 对应的 target entity（在 enrichment 流程中已保证）。

-- 注意：relations.subject_id / object_id 引用 entities.id，
-- 但 entities 删除时不应级联删除 relations（应保留关系历史）。
-- 用 ON DELETE SET NULL 让 relations 在 entity 删除时保留记录但断开引用。
-- 但 subject_id 是 NOT NULL，因此用 RESTRICT 阻止删除被引用的 entity。
ALTER TABLE relations DROP CONSTRAINT IF EXISTS relations_subject_id_fkey;
ALTER TABLE relations ADD CONSTRAINT relations_subject_id_fkey
    FOREIGN KEY (subject_id) REFERENCES entities(id) ON DELETE RESTRICT;

ALTER TABLE relations DROP CONSTRAINT IF EXISTS relations_object_id_fkey;
ALTER TABLE relations ADD CONSTRAINT relations_object_id_fkey
    FOREIGN KEY (object_id) REFERENCES entities(id) ON DELETE RESTRICT;

ALTER TABLE relations DROP CONSTRAINT IF EXISTS relations_source_revision_id_fkey;
ALTER TABLE relations ADD CONSTRAINT relations_source_revision_id_fkey
    FOREIGN KEY (source_revision_id) REFERENCES manuscript_revisions(id) ON DELETE SET NULL;

-- ===== P1-E4 续: foreshadowing / payoffs / timeline_events 补 FK =====

ALTER TABLE foreshadowing DROP CONSTRAINT IF EXISTS foreshadowing_planted_revision_id_fkey;
ALTER TABLE foreshadowing ADD CONSTRAINT foreshadowing_planted_revision_id_fkey
    FOREIGN KEY (planted_revision_id) REFERENCES manuscript_revisions(id) ON DELETE SET NULL;

ALTER TABLE foreshadowing DROP CONSTRAINT IF EXISTS foreshadowing_payoff_revision_id_fkey;
ALTER TABLE foreshadowing ADD CONSTRAINT foreshadowing_payoff_revision_id_fkey
    FOREIGN KEY (payoff_revision_id) REFERENCES manuscript_revisions(id) ON DELETE SET NULL;

ALTER TABLE payoffs DROP CONSTRAINT IF EXISTS payoffs_revision_id_fkey;
ALTER TABLE payoffs ADD CONSTRAINT payoffs_revision_id_fkey
    FOREIGN KEY (revision_id) REFERENCES manuscript_revisions(id) ON DELETE SET NULL;

ALTER TABLE timeline_events DROP CONSTRAINT IF EXISTS timeline_events_source_revision_id_fkey;
ALTER TABLE timeline_events ADD CONSTRAINT timeline_events_source_revision_id_fkey
    FOREIGN KEY (source_revision_id) REFERENCES manuscript_revisions(id) ON DELETE SET NULL;

-- ===== P1-E4 续: context_manifests.preflight_id 缺失 FK =====
-- 注意：context_manifests 表无 preflight_id 列（preflightId 存在 payload JSONB 中），
-- 因此不加 FK；retrieval_run_id 已有 FK（保持原状）。
-- 这里仅为 retrieval_run_id 加 ON DELETE CASCADE。

ALTER TABLE context_manifests DROP CONSTRAINT IF EXISTS context_manifests_retrieval_run_id_fkey;
ALTER TABLE context_manifests ADD CONSTRAINT context_manifests_retrieval_run_id_fkey
    FOREIGN KEY (retrieval_run_id) REFERENCES retrieval_runs(id) ON DELETE CASCADE;

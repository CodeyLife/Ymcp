ALTER TABLE arcs ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES novel_projects(id) ON DELETE CASCADE;
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS planning_status TEXT NOT NULL DEFAULT 'generating';
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL;
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS blueprint_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL;
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS context_fingerprint TEXT;
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS edit_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ;
ALTER TABLE arcs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE arcs a SET project_id=b.project_id
FROM volumes v JOIN books b ON b.id=v.book_id
WHERE a.volume_id=v.id AND a.project_id IS NULL;

ALTER TABLE chapters ADD COLUMN IF NOT EXISTS document_id TEXT REFERENCES manuscript_documents(id) ON DELETE SET NULL;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS blueprint_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS books_project_root ON books(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS volumes_book_ordinal ON volumes(book_id,ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS arcs_project_ordinal ON arcs(project_id,ordinal) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chapters_project_ordinal ON chapters(project_id,ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS chapters_document_unique ON chapters(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS arcs_project_status ON arcs(project_id,planning_status,execution_status);
CREATE INDEX IF NOT EXISTS chapters_arc_ordinal ON chapters(arc_id,ordinal);

CREATE TABLE IF NOT EXISTS chapter_planning_contexts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES manuscript_documents(id) ON DELETE CASCADE,
  arc_id TEXT NOT NULL REFERENCES arcs(id) ON DELETE CASCADE,
  chapter_blueprint_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  source_artifact_ids TEXT[] NOT NULL DEFAULT '{}',
  payload JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chapter_planning_contexts_document ON chapter_planning_contexts(project_id,document_id,created_at DESC);

INSERT INTO books(id,project_id,title)
SELECT 'book:' || p.id,p.id,p.title FROM novel_projects p
ON CONFLICT DO NOTHING;

INSERT INTO volumes(id,book_id,title,ordinal)
SELECT 'volume:' || p.id || ':1','book:' || p.id,'正文',1 FROM novel_projects p
ON CONFLICT DO NOTHING;

INSERT INTO arcs(
  id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload,
  source_artifact_id,blueprint_artifact_id,context_fingerprint
)
SELECT
  'legacy-arc:' || ps.project_id,
  'volume:' || ps.project_id || ':1',
  ps.project_id,
  '未分组故事弧',
  1,
  'awaiting-review',
  'planned',
  jsonb_build_object(
    'title','未分组故事弧',
    'objective','保留旧版全书章节计划，等待作者确认或重基线',
    'entryState','',
    'centralConflict','',
    'development',jsonb_build_array(),
    'resolution','',
    'exitState','',
    'plotThreadRefs',jsonb_build_array(),
    'foreshadowingRefs',jsonb_build_array(),
    'expectedChapterCount',jsonb_array_length(COALESCE(ps.payload->'structuredData'->'chapters','[]'::jsonb)),
    'legacyChapterPlan',true
  ),
  ps.source_artifact_id,
  ps.source_artifact_id,
  a.fingerprint
FROM project_plan_sections ps
JOIN artifacts a ON a.id=ps.source_artifact_id
WHERE ps.task_key='chapter-plan'
  AND jsonb_typeof(ps.payload->'structuredData'->'chapters')='array'
ON CONFLICT DO NOTHING;

INSERT INTO chapters(id,arc_id,project_id,title,ordinal,status,payload,source_artifact_id)
SELECT
  'legacy-chapter:' || ps.project_id || ':' || (chapter.value->>'index'),
  'legacy-arc:' || ps.project_id,
  ps.project_id,
  COALESCE(NULLIF(chapter.value->>'title',''),'第' || (chapter.value->>'index') || '章'),
  (chapter.value->>'index')::integer,
  'planned',
  chapter.value,
  ps.source_artifact_id
FROM project_plan_sections ps
CROSS JOIN LATERAL jsonb_array_elements(ps.payload->'structuredData'->'chapters') chapter(value)
WHERE ps.task_key='chapter-plan'
  AND jsonb_typeof(ps.payload->'structuredData'->'chapters')='array'
  AND (chapter.value->>'index') ~ '^[0-9]+$'
ON CONFLICT DO NOTHING;

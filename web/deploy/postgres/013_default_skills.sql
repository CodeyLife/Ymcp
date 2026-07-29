INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, quality_gates, prompt_sections)
VALUES
  ('longform-continuity', '1.0.0', ARRAY['draft','revision'], ARRAY['drafting','revision','review'], ARRAY['canonical','episodic','hierarchical'], ARRAY['continuity'], '{"drafting":"longform continuity"}'),
  ('independent-quality-gate', '1.0.0', ARRAY['review'], ARRAY['drafting','revision','review','planning'], ARRAY['canonical','episodic'], ARRAY['independent-review'], '{"review":"independent quality gate"}'),
  ('memory-consolidation', '1.0.0', ARRAY['memory'], ARRAY['memory-maintenance','planning','drafting','review','revision'], ARRAY['canonical','episodic','hierarchical'], ARRAY['memory-provenance'], '{"fact-extraction":"memory provenance"}')
ON CONFLICT(skill_id) DO NOTHING;

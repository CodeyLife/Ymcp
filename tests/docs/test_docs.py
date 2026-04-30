import json
from pathlib import Path

from ymcp.docs.template import TRAE_PROJECT_RULE_TEMPLATE


def test_docs_include_install_update_and_workflow_examples():
    readme = Path('README.md').read_text(encoding='utf-8')
    assert 'ydeep' in readme and 'yplan' in readme and 'ydo' in readme
    assert 'pip install ymcp' in readme


def test_trae_config_example_is_parseable():
    payload = json.loads(Path('examples/trae_mcp_config.example.json').read_text(encoding='utf-8'))
    assert payload['mcpServers']['ymcp']['command'] == 'ymcp'


def test_project_rule_template_keeps_memory_rules():
    assert '记忆规则' in TRAE_PROJECT_RULE_TEMPLATE
    assert 'mempalace_search' in TRAE_PROJECT_RULE_TEMPLATE


def test_project_rule_template_forbids_inferred_menu_selection():
    assert 'selected_option` 为 `null`' in TRAE_PROJECT_RULE_TEMPLATE
    assert '用户尚未选择任何菜单项' in TRAE_PROJECT_RULE_TEMPLATE
    assert '严禁根据 `recommended_next_action`' in TRAE_PROJECT_RULE_TEMPLATE
    assert '推断/模拟/假设用户选择' in TRAE_PROJECT_RULE_TEMPLATE
    assert 'ui_request.kind=await_selected_option' in TRAE_PROJECT_RULE_TEMPLATE
    assert '停止规划、分析、执行和下一步 tool 调用' in TRAE_PROJECT_RULE_TEMPLATE


def test_flowchart_doc_mentions_three_tools():
    flow = Path('docs/current-workflow-flowcharts.md').read_text(encoding='utf-8')
    assert 'ydeep' in flow
    assert 'yplan' in flow
    assert 'ydo' in flow


def test_skill_docs_avoid_stale_host_specific_tool_names():
    forbidden = [
        'AskUserQuestion',
        'task_context_bundle',
        'session_recall_search',
        'memory_read',
        'skills_list',
        'skill_view_safe',
        'memory_write',
        'skill_create_or_patch',
        'bundled_skill_read',
    ]
    for path in Path('skills').glob('*/SKILL.md'):
        text = path.read_text(encoding='utf-8')
        for name in forbidden:
            assert name not in text, f"{path} still references stale host tool {name}"


def test_plan_and_ralph_skills_include_unified_menu_boundaries():
    plan = Path('skills/plan/SKILL.md').read_text(encoding='utf-8')
    ralph = Path('skills/ralph/SKILL.md').read_text(encoding='utf-8')
    deep = Path('skills/deep-interview/SKILL.md').read_text(encoding='utf-8')
    assert '# Planning Complete' in plan
    assert 'unified handoff tool: `menu`' in plan
    assert 'Use `yplan` as the planning entry and `menu` as the only workflow handoff surface' in plan
    assert 'The host must render a real interactive control from `handoff.options`' in plan
    assert 'WebUI fallback' in plan
    assert 'source_workflow="ydeep"' in deep
    assert 'source_workflow="ydo"' in ralph
    assert '# Execution Start' in ralph
    assert '# Execution Complete' in ralph
    assert 'Do not recommend `finish` if failures remain or verification is incomplete' in ralph


def test_workflow_skills_restore_reference_methodology_with_ymcp_boundaries():
    deep = Path('skills/deep-interview/SKILL.md').read_text(encoding='utf-8')
    plan = Path('skills/plan/SKILL.md').read_text(encoding='utf-8')
    ralplan = Path('skills/ralplan/SKILL.md').read_text(encoding='utf-8')
    ralph = Path('skills/ralph/SKILL.md').read_text(encoding='utf-8')

    assert 'ambiguity = 1 -' in deep
    assert 'Non-goals' in deep and 'Decision Boundaries' in deep
    assert 'pressure pass' in deep
    assert 'challenge modes' in deep
    assert '不能把未实际生成的文件声称为已存在' in deep

    assert 'RALPLAN-DR summary' in plan
    assert 'strongest steelman antithesis' in plan
    assert '最多 5 轮' in plan
    assert 'deliberate mode' in plan
    assert 'Pre-Execution Gate' in plan

    assert 'Alias for $plan --consensus' in ralplan
    assert '公共工作流入口是：`ydeep`、`yplan`、`ydo`、`menu`' in ralplan

    assert 'Restored execution pressure' in ralph
    assert 'cleanup/deslop 后回归验证' in ralph
    assert '不要声称 Ymcp 服务端已自动创建这些文件' in ralph


def test_workflow_text_avoids_obsolete_tool_guidance():
    obsolete_terms = [
        'yplan_architect',
        'yplan_critic',
        'yplan_menu',
        'no longer public',
        '不再公开',
        '已删除',
        'deleted',
    ]
    workflow_paths = [
        Path('skills/deep-interview/SKILL.md'),
        Path('skills/plan/SKILL.md'),
        Path('skills/ralplan/SKILL.md'),
        Path('skills/ralph/SKILL.md'),
        Path('src/ymcp/engine/ralplan.py'),
        Path('src/ymcp/contracts/ralplan.py'),
    ]
    for path in workflow_paths:
        text = path.read_text(encoding='utf-8').lower()
        for term in obsolete_terms:
            assert term.lower() not in text, f"{path} contains obsolete workflow guidance: {term}"

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


def test_plan_and_ralph_skills_include_phase_boundary_templates():
    plan = Path('skills/plan/SKILL.md').read_text(encoding='utf-8')
    critic = Path('skills/critic/SKILL.md').read_text(encoding='utf-8')
    ralph = Path('skills/ralph/SKILL.md').read_text(encoding='utf-8')
    assert '# Planning Complete' in plan
    assert 'Do not say the task is complete; only the planning phase is complete' in plan
    assert 'Do not call `yplan_menu` with only `schema_version`' in plan
    assert 'The host must render a real interactive control from `handoff.options`' in plan
    assert 'you must restart planning at `yplan`' in plan
    assert 'If you judge the plan as ready, you must do the approved path in this order' in critic
    assert 'choose `yplan` from the returned `handoff.options`' in critic
    assert 'Do not call `yplan_menu` with only `schema_version`' in critic
    architect = Path('skills/architect/SKILL.md').read_text(encoding='utf-8')
    assert 'Do not stop after writing the architecture review' in architect
    assert 'immediately call `yplan_critic` with `architect_summary`' in architect
    assert '# Execution Start' in ralph
    assert '# Execution Complete' in ralph
    assert 'Do not recommend `finish` if failures remain or verification is incomplete' in ralph

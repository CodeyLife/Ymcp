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


def test_flowchart_doc_mentions_three_tools():
    flow = Path('docs/current-workflow-flowcharts.md').read_text(encoding='utf-8')
    assert 'ydeep' in flow
    assert 'yplan' in flow
    assert 'ydo' in flow

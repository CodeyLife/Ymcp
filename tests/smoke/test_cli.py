import json
import subprocess
import sys
from pathlib import Path

from ymcp.cli import main
from ymcp.contracts.memory import MEMPALACE_TOOL_SCHEMAS

WORKFLOW_NAMES = {'ydeep', 'ydeep_menu', 'yplan', 'yplan_architect', 'yplan_critic', 'yplan_menu', 'ydo', 'ydo_menu', 'yimggen'}
MEMORY_NAMES = {tool['name'] for tool in MEMPALACE_TOOL_SCHEMAS}
EXPECTED_NAMES = WORKFLOW_NAMES | MEMORY_NAMES
RESOURCE_URIS = {
    'resource://ymcp/principles',
    'resource://ymcp/memory-protocol',
    'resource://ymcp/workflow-contracts',
    'resource://ymcp/project-rule-template',
}
PROMPT_NAMES = {
    'architect',
    'critic',
    'deep-interview',
    'imagegen',
    'plan',
    'planner',
    'ralph',
    'ralplan',
    'workflow-menu',
}


def test_inspect_tools_json_command(capsys):
    assert main(['inspect-tools', '--json']) == 0
    payload = json.loads(capsys.readouterr().out)
    assert {item['name'] for item in payload} == EXPECTED_NAMES


def test_inspect_resources_json_command(capsys):
    assert main(['inspect-resources', '--json']) == 0
    payload = json.loads(capsys.readouterr().out)
    assert {item['uri'] for item in payload} == RESOURCE_URIS


def test_inspect_prompts_json_command(capsys):
    assert main(['inspect-prompts', '--json']) == 0
    payload = json.loads(capsys.readouterr().out)
    assert {item['name'] for item in payload} == PROMPT_NAMES


def test_call_fixture_json_for_all_tools(capsys):
    for tool_name in ['ydeep', 'ydeep_menu', 'yplan', 'yplan_architect', 'yplan_critic', 'yplan_menu', 'ydo', 'ydo_menu', 'yimggen', 'mempalace_status']:
        assert main(['call-fixture', tool_name, '--json']) == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload['meta']['tool_name'] == tool_name


def test_example_host_call_all_tools_runs():
    completed = subprocess.run([sys.executable, 'examples/host_call_all_tools.py'], check=True, capture_output=True, text=True)
    assert 'ydeep:' in completed.stdout
    assert 'ydeep_menu:' in completed.stdout
    assert 'yplan:' in completed.stdout
    assert 'yplan_architect:' in completed.stdout
    assert 'yplan_critic:' in completed.stdout
    assert 'yplan_menu:' in completed.stdout
    assert 'ydo:' in completed.stdout
    assert 'ydo_menu:' in completed.stdout
    assert 'yimggen:' in completed.stdout

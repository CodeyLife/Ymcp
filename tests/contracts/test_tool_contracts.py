from ymcp.cli import inspect_tools_payload
from ymcp.contracts.memory import MEMPALACE_TOOL_SCHEMAS
from ymcp.core.versioning import SCHEMA_VERSION
from ymcp.internal_registry import get_tool_specs

WORKFLOW_NAMES = {'ydeep', 'ydeep_complete', 'yplan', 'yplan_architect', 'yplan_critic', 'yplan_complete', 'ydo', 'ydo_complete'}
MEMORY_NAMES = {tool['name'] for tool in MEMPALACE_TOOL_SCHEMAS}
EXPECTED_NAMES = WORKFLOW_NAMES | MEMORY_NAMES
COMMON_FIELDS = {'schema_version', 'status', 'summary', 'assumptions', 'next_actions', 'risks', 'meta', 'artifacts'}


def test_canonical_tool_names():
    assert {spec.name for spec in get_tool_specs()} == EXPECTED_NAMES


def test_tool_descriptions_include_skill_and_gate_constraints():
    descriptions = {spec.name: spec.description for spec in get_tool_specs()}
    assert 'deep-interview' in descriptions['ydeep']
    assert 'deep-interview' in descriptions['ydeep_complete']
    assert 'planner' in descriptions['yplan']
    assert 'architect' in descriptions['yplan_architect']
    assert 'critic' in descriptions['yplan_critic']
    assert 'ydo' in descriptions['yplan_complete']
    assert 'ralph' in descriptions['ydo']
    assert 'finish' in descriptions['ydo_complete']


def test_response_models_include_common_fields_and_v1_schema():
    for spec in get_tool_specs():
        fields = set(spec.response_model.model_fields)
        assert COMMON_FIELDS <= fields
        assert spec.response_model.model_fields['schema_version'].default == SCHEMA_VERSION


def test_inspect_tools_json_contract_metadata():
    payload = inspect_tools_payload()
    assert {item['name'] for item in payload} == EXPECTED_NAMES
    assert payload[0]['request_schema']

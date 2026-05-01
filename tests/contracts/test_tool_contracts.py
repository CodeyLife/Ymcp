from ymcp.cli import inspect_tools_payload
from ymcp.contracts.memory import MEMPALACE_TOOL_SCHEMAS
from ymcp.core.versioning import SCHEMA_VERSION
from ymcp.internal_registry import get_tool_specs

WORKFLOW_NAMES = {'ydeep', 'yplan', 'ydo', 'menu', 'yimggen'}
MEMORY_NAMES = {tool['name'] for tool in MEMPALACE_TOOL_SCHEMAS}
EXPECTED_NAMES = WORKFLOW_NAMES | MEMORY_NAMES
COMMON_FIELDS = {'schema_version', 'status', 'summary', 'assumptions', 'next_actions', 'risks', 'meta', 'artifacts'}


def test_canonical_tool_names():
    assert {spec.name for spec in get_tool_specs()} == EXPECTED_NAMES


def test_tool_descriptions_include_skill_and_gate_constraints():
    descriptions = {spec.name: spec.description for spec in get_tool_specs()}
    assert 'deep-interview' in descriptions['ydeep']
    assert 'phase=start/planner/architect/critic' in descriptions['yplan']
    assert 'ralph' in descriptions['ydo']
    assert 'workflow-menu' in descriptions['menu']
    assert 'Elicitation' in descriptions['menu']
    assert 'WebUI fallback' in descriptions['menu']
    assert 'imagegen' in descriptions['yimggen']
    assert 'Pillow' in descriptions['yimggen']
    assert '不调用远程图片 API' in descriptions['yimggen']


def test_response_models_include_common_fields_and_v1_schema():
    for spec in get_tool_specs():
        fields = set(spec.response_model.model_fields)
        assert COMMON_FIELDS <= fields
        assert spec.response_model.model_fields['schema_version'].default == SCHEMA_VERSION


def test_inspect_tools_json_contract_metadata():
    payload = inspect_tools_payload()
    assert {item['name'] for item in payload} == EXPECTED_NAMES
    assert payload[0]['request_schema']

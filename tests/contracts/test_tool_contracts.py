from ymcp.cli import inspect_tools_payload
from ymcp.contracts.common import ToolResultBase
from ymcp.core.versioning import SCHEMA_VERSION
from ymcp.internal_registry import get_tool_specs

EXPECTED_NAMES = {"plan", "ralplan", "deep_interview", "ralph"}
COMMON_FIELDS = {"schema_version", "status", "summary", "assumptions", "next_actions", "risks", "meta", "artifacts"}


def test_canonical_tool_names():
    assert {spec.name for spec in get_tool_specs()} == EXPECTED_NAMES


def test_tool_descriptions_include_host_control_boundaries():
    descriptions = {spec.name: spec.description for spec in get_tool_specs()}
    assert "Does not execute commands" in descriptions["ralph"]
    assert "spawn agents" in descriptions["ralph"]
    assert "modify files" in descriptions["ralph"]
    assert "persist loops" in descriptions["ralph"]
    assert "verify completion itself" in descriptions["ralph"]
    assert "host asks the user" in descriptions["deep_interview"].lower()
    assert "owns transcript/state" in descriptions["deep_interview"]


def test_response_models_include_common_fields_and_v1_schema():
    for spec in get_tool_specs():
        fields = set(spec.response_model.model_fields)
        assert COMMON_FIELDS <= fields
        assert spec.response_model.model_fields["schema_version"].default == SCHEMA_VERSION
        assert spec.response_model.model_fields["artifacts"].annotation is not None


def test_inspect_tools_json_contract_metadata():
    payload = inspect_tools_payload()
    assert {item["name"] for item in payload} == EXPECTED_NAMES
    for item in payload:
        assert item["schema_version"] == SCHEMA_VERSION
        assert item["request_schema"]
        assert item["response_schema"]
        assert item["description"]


def test_docs_do_not_publish_plugin_or_catalog_api():
    import pathlib
    text = "\n".join(path.read_text(encoding="utf-8") for path in pathlib.Path("docs").glob("*.md"))
    assert "public plugin" not in text.lower()
    assert "plugin api" not in text.lower()
    assert "catalog api" not in text.lower()

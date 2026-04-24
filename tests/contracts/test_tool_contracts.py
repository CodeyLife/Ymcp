from ymcp.cli import inspect_tools_payload
from ymcp.contracts.memory import MEMPALACE_TOOL_SCHEMAS
from ymcp.core.versioning import SCHEMA_VERSION
from ymcp.internal_registry import get_tool_specs

WORKFLOW_NAMES = {"plan", "ralplan", "deep_interview", "ralph"}
MEMORY_NAMES = {tool["name"] for tool in MEMPALACE_TOOL_SCHEMAS}
EXPECTED_NAMES = WORKFLOW_NAMES | MEMORY_NAMES
COMMON_FIELDS = {"schema_version", "status", "summary", "assumptions", "next_actions", "risks", "meta", "artifacts"}


def test_canonical_tool_names():
    assert {spec.name for spec in get_tool_specs()} == EXPECTED_NAMES


def test_tool_descriptions_include_boundaries():
    descriptions = {spec.name: spec.description for spec in get_tool_specs()}
    assert "不执行命令" in descriptions["ralph"]
    assert "宿主" in descriptions["deep_interview"]
    assert "palace" in descriptions["mempalace_add_drawer"].lower()
    assert "search" in descriptions["mempalace_search"].lower()


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
        assert item["host_boundary"]


def test_inspect_schema_matches_mempalace_native_parameter_names():
    payload = {item["name"]: item for item in inspect_tools_payload()}
    assert "start" not in payload["mempalace_follow_tunnels"]["request_schema"]["properties"]
    assert "limit" not in payload["mempalace_diary_read"]["request_schema"]["properties"]
    assert "source" not in payload["mempalace_kg_invalidate"]["request_schema"]["properties"]
    assert "room" in payload["mempalace_follow_tunnels"]["request_schema"]["properties"]
    assert "last_n" in payload["mempalace_diary_read"]["request_schema"]["properties"]
    assert "source_closet" in payload["mempalace_kg_add"]["request_schema"]["properties"]
    assert "project_id" in payload["mempalace_add_drawer"]["request_schema"]["properties"]
    assert "project_root" in payload["mempalace_search"]["request_schema"]["properties"]
    assert "wing" not in payload["mempalace_add_drawer"]["request_schema"].get("required", [])


def test_docs_do_not_publish_plugin_or_catalog_api():
    import pathlib
    text = "\n".join(path.read_text(encoding="utf-8") for path in pathlib.Path("docs").glob("*.md"))
    assert "public plugin" not in text.lower()
    assert "plugin api" not in text.lower()
    assert "catalog api" not in text.lower()

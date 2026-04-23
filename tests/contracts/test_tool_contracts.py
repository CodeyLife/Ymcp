from ymcp.cli import inspect_tools_payload
from ymcp.core.versioning import SCHEMA_VERSION
from ymcp.internal_registry import get_tool_specs

WORKFLOW_NAMES = {"plan", "ralplan", "deep_interview", "ralph"}
MEMORY_NAMES = {
    "memory_store", "memory_search", "memory_get", "memory_update", "memory_delete",
    "memory_status", "memory_list_wings", "memory_list_rooms", "memory_taxonomy",
    "memory_check_duplicate", "memory_reconnect", "memory_graph_stats", "memory_graph_query",
    "memory_graph_traverse", "memory_kg_add", "memory_kg_timeline", "memory_kg_invalidate",
    "memory_create_tunnel", "memory_list_tunnels", "memory_find_tunnels", "memory_follow_tunnels",
    "memory_delete_tunnel", "memory_diary_write", "memory_diary_read",
}
EXPECTED_NAMES = WORKFLOW_NAMES | MEMORY_NAMES
COMMON_FIELDS = {"schema_version", "status", "summary", "assumptions", "next_actions", "risks", "meta", "artifacts"}


def test_canonical_tool_names():
    assert {spec.name for spec in get_tool_specs()} == EXPECTED_NAMES


def test_tool_descriptions_include_boundaries():
    descriptions = {spec.name: spec.description for spec in get_tool_specs()}
    assert "不执行命令" in descriptions["ralph"]
    assert "宿主" in descriptions["deep_interview"]
    assert "MemPalace" in descriptions["memory_store"]
    assert "长期记忆" in descriptions["memory_search"]


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


def test_docs_do_not_publish_plugin_or_catalog_api():
    import pathlib
    text = "\n".join(path.read_text(encoding="utf-8") for path in pathlib.Path("docs").glob("*.md"))
    assert "public plugin" not in text.lower()
    assert "plugin api" not in text.lower()
    assert "catalog api" not in text.lower()

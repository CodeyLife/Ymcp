from ymcp.cli import inspect_tools_payload

WORKFLOW_NAMES = {"plan", "ralplan", "deep_interview", "ralph"}
REQUIRED_WORKFLOW_FIELDS = {"workflow_state"}


def test_workflow_tools_expose_state_machine_metadata():
    payload = {item["name"]: item for item in inspect_tools_payload()}
    for name in WORKFLOW_NAMES:
        response_schema = payload[name]["response_schema"]
        artifacts_schema = response_schema["$defs"][response_schema["properties"]["artifacts"]["$ref"].split("/")[-1]]
        assert REQUIRED_WORKFLOW_FIELDS <= set(artifacts_schema["properties"])
        assert "interaction" not in artifacts_schema["properties"]
        assert "continuation" not in artifacts_schema["properties"]


def test_workflow_descriptions_are_mcp_first_and_host_controlled():
    payload = {item["name"]: item for item in inspect_tools_payload()}
    assert "MCP" in payload["plan"]["description"]
    assert "Elicitation" in payload["ralplan"]["description"]
    assert "Elicitation" in payload["deep_interview"]["description"]
    assert "Elicitation" in payload["ralph"]["description"]


def test_tool_call_template_contract_removed_from_main_workflow_protocol():
    import ymcp.contracts.workflow as workflow
    assert not hasattr(workflow, "WorkflowInteraction")
    assert not hasattr(workflow, "ContinuationContract")


def test_workflow_state_exposes_memory_preflight():
    from ymcp.contracts.workflow import WorkflowState
    assert "memory_preflight" in WorkflowState.model_fields


def test_workflow_state_no_longer_exposes_host_action_type():
    from ymcp.contracts.workflow import WorkflowState
    assert "host_action_type" not in WorkflowState.model_fields


def test_memory_preflight_records_search_results_fields():
    from ymcp.contracts.workflow import MemoryPreflight
    assert {"search_performed", "retrieved_count", "retrieved_context"} <= set(MemoryPreflight.model_fields)


def test_memory_context_contract_exists():
    from ymcp.contracts.workflow import MemoryContext
    assert {"searched", "hits", "failed", "query"} <= set(MemoryContext.model_fields)


def test_workflow_state_exposes_memory_protocol():
    from ymcp.contracts.workflow import WorkflowState
    fields = set(WorkflowState.model_fields)
    assert {"memory_protocol_summary", "memory_protocol"} <= fields


def test_workflow_choice_option_contract_exists():
    from ymcp.contracts.workflow import WorkflowChoiceOption
    assert {"id", "label", "description", "tool", "recommended", "requires_user_selection"} <= set(WorkflowChoiceOption.model_fields)

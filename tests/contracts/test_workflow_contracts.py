from ymcp.cli import inspect_tools_payload

WORKFLOW_NAMES = {"plan", "ralplan", "ralplan_planner", "ralplan_architect", "ralplan_critic", "ralplan_handoff", "deep_interview", "ralph"}
REQUIRED_WORKFLOW_FIELDS = {"workflow_state"}


def test_workflow_tools_expose_state_machine_metadata():
    payload = {item["name"]: item for item in inspect_tools_payload()}
    for name in WORKFLOW_NAMES:
        response_schema = payload[name]["response_schema"]
        artifacts_schema = response_schema["$defs"][response_schema["properties"]["artifacts"]["$ref"].split("/")[-1]]
        assert REQUIRED_WORKFLOW_FIELDS <= set(artifacts_schema["properties"])
        assert "interaction" not in artifacts_schema["properties"]
        assert "continuation" not in artifacts_schema["properties"]
        assert "choice_menu" not in artifacts_schema["properties"]
        assert "requested_input" not in artifacts_schema["properties"]


def test_workflow_descriptions_are_mcp_first_and_host_controlled():
    payload = {item["name"]: item for item in inspect_tools_payload()}
    assert "MCP" in payload["plan"]["description"]
    assert "handoff" in payload["ralplan"]["description"] or "Handoff" in payload["ralplan"]["description"] or "子工具" in payload["ralplan"]["description"]
    assert "Planner" in payload["ralplan_planner"]["description"]
    assert "Elicitation" in payload["ralplan_handoff"]["description"]
    assert "Elicitation" in payload["deep_interview"]["description"]
    assert "Elicitation" in payload["ralph"]["description"]


def test_tool_call_template_contract_removed_from_main_workflow_protocol():
    import ymcp.contracts.workflow as workflow
    assert not hasattr(workflow, "WorkflowInteraction")
    assert not hasattr(workflow, "ContinuationContract")
    assert not hasattr(workflow, "WorkflowChoiceOption")
    assert not hasattr(workflow, "WorkflowChoiceMenu")


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


def test_workflow_state_keeps_minimal_host_fields():
    from ymcp.contracts.workflow import WorkflowState
    fields = set(WorkflowState.model_fields)
    assert {"workflow_name", "current_phase", "readiness", "evidence_gaps", "blocked_reason", "memory_preflight"} <= fields
    assert "skill_source" not in fields
    assert "memory_protocol_summary" not in fields
    assert "memory_protocol" not in fields


from ymcp.cli import inspect_tools_payload

WORKFLOW_NAMES = {"plan", "ralplan", "deep_interview", "ralph"}
REQUIRED_WORKFLOW_FIELDS = {"workflow_state"}


def test_workflow_tools_expose_state_machine_metadata():
    payload = {item["name"]: item for item in inspect_tools_payload()}
    for name in WORKFLOW_NAMES:
        response_schema = payload[name]["response_schema"]
        artifacts_schema = response_schema["$defs"][response_schema["properties"]["artifacts"]["$ref"].split("/")[-1]]
        assert "workflow_state" in artifacts_schema["properties"]
        assert "continuation" in artifacts_schema["properties"]


def test_workflow_descriptions_are_chinese_and_host_controlled():
    payload = {item["name"]: item for item in inspect_tools_payload()}
    assert "状态机投影" in payload["plan"]["description"]
    assert "状态机投影" in payload["ralplan"]["description"]
    assert "宿主" in payload["deep_interview"]["description"]
    assert "宿主" in payload["ralph"]["description"]



def test_continuation_contract_exposes_handoff_options():
    from ymcp.contracts.workflow import ContinuationContract
    fields = set(ContinuationContract.model_fields)
    assert {"handoff_options", "tool_call_templates", "default_option", "selection_required", "option_prompt"} <= fields


def test_tool_call_template_contract_exists():
    from ymcp.contracts.workflow import ToolCallTemplate
    assert {"tool", "purpose", "arguments"} <= set(ToolCallTemplate.model_fields)



def test_workflow_state_exposes_memory_preflight():
    from ymcp.contracts.workflow import WorkflowState
    assert "memory_preflight" in WorkflowState.model_fields


def test_workflow_state_exposes_host_action_type():
    from ymcp.contracts.workflow import WorkflowState
    assert "host_action_type" in WorkflowState.model_fields



def test_memory_preflight_records_search_results_fields():
    from ymcp.contracts.workflow import MemoryPreflight
    assert {"search_performed", "retrieved_count", "retrieved_context"} <= set(MemoryPreflight.model_fields)


def test_memory_context_contract_exists():
    from ymcp.contracts.workflow import MemoryContext
    assert {"searched", "hits", "failed", "query"} <= set(MemoryContext.model_fields)


def test_continuation_contract_rejects_invalid_selection_combination():
    import pytest
    from ymcp.contracts.workflow import ContinuationContract

    with pytest.raises(ValueError):
        ContinuationContract(
            interaction_mode="handoff",
            continuation_required=False,
            continuation_kind="select_handoff_option",
            recommended_host_action="展示选项",
            selection_required=True,
            option_prompt="请选择",
        )


def test_workflow_state_exposes_memory_protocol():
    from ymcp.contracts.workflow import WorkflowState
    fields = set(WorkflowState.model_fields)
    assert {"memory_protocol_summary", "memory_protocol"} <= fields

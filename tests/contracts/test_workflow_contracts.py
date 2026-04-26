from ymcp.cli import inspect_tools_payload

WORKFLOW_NAMES = {'ydeep', 'ydeep_complete', 'yplan', 'yplan_architect', 'yplan_critic', 'yplan_complete', 'ydo', 'ydo_complete'}


def test_workflow_tools_expose_state_machine_metadata():
    payload = {item['name']: item for item in inspect_tools_payload()}
    for name in WORKFLOW_NAMES:
        response_schema = payload[name]['response_schema']
        artifacts_schema = response_schema['$defs'][response_schema['properties']['artifacts']['$ref'].split('/')[-1]]
        assert 'workflow_state' in artifacts_schema['properties']


def test_yplan_schema_exposes_stepwise_prompt_fields():
    payload = {item['name']: item for item in inspect_tools_payload()}
    response_schema = payload['yplan']['response_schema']
    artifacts_schema = response_schema['$defs'][response_schema['properties']['artifacts']['$ref'].split('/')[-1]]
    assert 'suggested_prompt' in artifacts_schema['properties']
    assert 'next_tool' in artifacts_schema['properties']

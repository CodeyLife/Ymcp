from ymcp.cli import inspect_tools_payload

WORKFLOW_NAMES = {'ydeep', 'ydeep_complete', 'yplan', 'yplan_architect', 'yplan_critic', 'yplan_complete', 'ydo', 'ydo_complete'}


def test_workflow_tools_expose_state_machine_metadata():
    payload = {item['name']: item for item in inspect_tools_payload()}
    for name in WORKFLOW_NAMES:
        response_schema = payload[name]['response_schema']
        artifacts_schema = response_schema['$defs'][response_schema['properties']['artifacts']['$ref'].split('/')[-1]]
        assert 'workflow_state' in artifacts_schema['properties']


def test_yplan_schema_exposes_handoff_and_skill_fields():
    payload = {item['name']: item for item in inspect_tools_payload()}
    response_schema = payload['yplan']['response_schema']
    meta_schema = response_schema['$defs'][response_schema['properties']['meta']['$ref'].split('/')[-1]]
    artifacts_schema = response_schema['$defs'][response_schema['properties']['artifacts']['$ref'].split('/')[-1]]
    assert 'handoff' in meta_schema['properties']
    assert 'skill_content' in artifacts_schema['properties']
    assert 'planning_artifact' not in artifacts_schema['properties']


def test_handoff_schema_exposes_minimal_option_metadata():
    payload = {item['name']: item for item in inspect_tools_payload()}
    response_schema = payload['yplan_complete']['response_schema']
    meta_schema = response_schema['$defs'][response_schema['properties']['meta']['$ref'].split('/')[-1]]
    handoff_schema = response_schema['$defs'][meta_schema['properties']['handoff']['anyOf'][0]['$ref'].split('/')[-1]]
    option_schema = response_schema['$defs'][handoff_schema['properties']['options']['items']['$ref'].split('/')[-1]]
    assert 'recommended_next_action' in handoff_schema['properties']
    assert {'value', 'title', 'description', 'recommended'} <= set(option_schema['properties'])

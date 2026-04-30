from ymcp.cli import inspect_tools_payload

WORKFLOW_NAMES = {'ydeep', 'yplan', 'ydo', 'menu'}


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


def test_menu_schema_exposes_dynamic_options_and_handoff_metadata():
    payload = {item['name']: item for item in inspect_tools_payload()}
    request_schema = payload['menu']['request_schema']
    response_schema = payload['menu']['response_schema']
    assert {'source_workflow', 'summary', 'options'} <= set(request_schema['properties'])
    meta_schema = response_schema['$defs'][response_schema['properties']['meta']['$ref'].split('/')[-1]]
    handoff_schema = response_schema['$defs'][meta_schema['properties']['handoff']['anyOf'][0]['$ref'].split('/')[-1]]
    option_schema = response_schema['$defs'][handoff_schema['properties']['options']['items']['$ref'].split('/')[-1]]
    assert 'recommended_next_action' in handoff_schema['properties']
    assert {'value', 'title', 'description', 'recommended'} <= set(option_schema['properties'])

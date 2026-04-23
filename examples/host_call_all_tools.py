from ymcp.fixtures import FIXTURES, fixture_for
from ymcp.internal_registry import get_tool_specs

specs = {spec.name: spec for spec in get_tool_specs()}

for tool_name in FIXTURES:
    spec = specs[tool_name]
    request = spec.request_model.model_validate(fixture_for(tool_name))
    response = spec.handler(request)
    print(f"{tool_name}: {response.status}")

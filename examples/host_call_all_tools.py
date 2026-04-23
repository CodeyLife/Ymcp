from ymcp.fixtures import fixture_for
from ymcp.internal_registry import get_tool_specs


for spec in get_tool_specs():
    request = spec.request_model.model_validate(fixture_for(spec.name))
    response = spec.handler(request)
    print(f"{spec.name}: {response.status}")

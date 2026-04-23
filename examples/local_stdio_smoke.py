from ymcp.cli import inspect_tools_payload

for item in inspect_tools_payload():
    print(item["name"])

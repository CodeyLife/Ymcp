import json
import subprocess
import sys

from ymcp.cli import main

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


def test_version_command(capsys):
    assert main(["--version"]) == 0
    assert capsys.readouterr().out.strip()


def test_inspect_tools_json_command(capsys):
    assert main(["inspect-tools", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert {item["name"] for item in payload} == EXPECTED_NAMES
    assert all(item["host_boundary"] for item in payload)


def test_doctor_json_command(capsys):
    exit_code = main(["doctor", "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert exit_code in {0, 1}
    assert payload["python"]["supported"] is True
    assert "mcp" in payload["packages"]
    assert payload["mempalace"]["default_wing"] == "personal"
    assert payload["trae"]["recommended_config_command"] == "ymcp print-config --host trae"


def test_print_config_for_trae(capsys):
    assert main(["print-config", "--host", "trae"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mcpServers"]["ymcp"]["command"] == "ymcp"
    assert payload["mcpServers"]["ymcp"]["args"] == ["serve"]


def test_call_fixture_json_for_all_tools(capsys):
    for tool_name in ["plan", "ralplan", "deep_interview", "ralph", "memory_status", "memory_search"]:
        assert main(["call-fixture", tool_name, "--json"]) == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["meta"]["tool_name"] == tool_name
        assert payload["schema_version"] == "1.0"
        assert payload["artifacts"]


def test_example_host_call_all_tools_runs():
    completed = subprocess.run(
        [sys.executable, "examples/host_call_all_tools.py"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "plan:" in completed.stdout
    assert "ralph:" in completed.stdout


def test_init_trae_updates_user_mcp_json_and_creates_rules(tmp_path, monkeypatch, capsys):
    config_dir = tmp_path / "User"
    project_root = tmp_path / "project"
    project_root.mkdir()
    monkeypatch.setattr("builtins.input", lambda _: "y")
    assert main([
        "init-trae",
        "--config-dir", str(config_dir),
        "--project-root", str(project_root),
    ]) == 0
    mcp_path = config_dir / "mcp.json"
    assert mcp_path.exists()
    payload = json.loads(mcp_path.read_text(encoding="utf-8"))
    assert payload["mcpServers"]["ymcp"]["command"] == "ymcp"
    rules_path = project_root / ".trae" / "rules" / "ymcp-workflow-rules.md"
    assert rules_path.exists()
    output = capsys.readouterr().out
    assert "已更新 Trae MCP 配置" in output
    assert "已创建/更新 Trae 项目规则" in output


def test_init_trae_can_skip_rules_and_merge_existing_json(tmp_path, capsys):
    config_dir = tmp_path / "User"
    config_dir.mkdir(parents=True)
    (config_dir / "mcp.json").write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}}), encoding="utf-8")
    project_root = tmp_path / "project"
    project_root.mkdir()
    assert main([
        "init-trae",
        "--config-dir", str(config_dir),
        "--project-root", str(project_root),
        "--no-project-rules",
    ]) == 0
    payload = json.loads((config_dir / "mcp.json").read_text(encoding="utf-8"))
    assert "other" in payload["mcpServers"]
    assert payload["mcpServers"]["ymcp"]["args"] == ["serve"]
    assert not (project_root / ".trae" / "rules" / "ymcp-workflow-rules.md").exists()
    assert "已跳过项目规则创建" in capsys.readouterr().out


def test_init_trae_accepts_underscore_and_typo_aliases(tmp_path):
    for command in ["init_trae", "init_trea"]:
        config_dir = tmp_path / command / "User"
        project_root = tmp_path / command / "project"
        project_root.mkdir(parents=True)
        assert main([
            command,
            "--config-dir", str(config_dir),
            "--project-root", str(project_root),
            "--no-project-rules",
        ]) == 0
        payload = json.loads((config_dir / "mcp.json").read_text(encoding="utf-8"))
        assert payload["mcpServers"]["ymcp"]["args"] == ["serve"]

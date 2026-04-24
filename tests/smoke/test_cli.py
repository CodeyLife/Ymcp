import json
import subprocess
import sys
from pathlib import Path

from ymcp.cli import doctor_payload, main, resolve_mempalace_dir
from ymcp.contracts.memory import MEMPALACE_TOOL_SCHEMAS

WORKFLOW_NAMES = {"plan", "ralplan", "deep_interview", "ralph"}
MEMORY_NAMES = {tool["name"] for tool in MEMPALACE_TOOL_SCHEMAS}
EXPECTED_NAMES = WORKFLOW_NAMES | MEMORY_NAMES
RESOURCE_URIS = {
    "resource://ymcp/principles",
    "resource://ymcp/tool-reference",
    "resource://ymcp/memory-protocol",
    "resource://ymcp/project-rule-template",
    "resource://ymcp/host-integration",
}
PROMPT_NAMES = {
    "deep_interview_clarify",
    "plan_direct",
    "ralplan_consensus",
    "ralplan_planner_pass",
    "ralplan_architect_pass",
    "ralplan_critic_pass",
    "ralph_verify",
    "memory_store_after_completion",
}


def test_version_command(capsys):
    assert main(["--version"]) == 0
    assert capsys.readouterr().out.strip()


def test_inspect_tools_json_command(capsys):
    assert main(["inspect-tools", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert {item["name"] for item in payload} == EXPECTED_NAMES
    assert all(item["host_boundary"] for item in payload)


def test_inspect_resources_json_command(capsys):
    assert main(["inspect-resources", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert {item["uri"] for item in payload} == RESOURCE_URIS
    assert all(item["primitive"] == "resource" for item in payload)


def test_inspect_prompts_json_command(capsys):
    assert main(["inspect-prompts", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert {item["name"] for item in payload} == PROMPT_NAMES
    assert all(item["primitive"] == "prompt" for item in payload)
    assert all(item["execution_boundary"] for item in payload)


def test_inspect_capabilities_json_command(capsys):
    assert main(["inspect-capabilities", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert "FastMCP-first" in payload["principle"]
    assert {item["name"] for item in payload["tools"]} == EXPECTED_NAMES
    assert {item["uri"] for item in payload["resources"]} == RESOURCE_URIS
    assert {item["name"] for item in payload["prompts"]} == PROMPT_NAMES


def test_doctor_json_command(capsys):
    exit_code = main(["doctor", "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert exit_code in {0, 1}
    assert payload["python"]["supported"] is True
    assert "mcp" in payload["packages"]
    assert payload["mempalace"]["default_wing"] == "personal"
    assert payload["mempalace"]["wing_resolution"] == "wing → project_id → project_root → YMCP_DEFAULT_WING → personal"
    assert payload["trae"]["recommended_config_command"] == "ymcp print-config --host trae"


def test_print_config_for_trae(capsys):
    assert main(["print-config", "--host", "trae"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mcpServers"]["ymcp"]["command"] == "ymcp"
    assert payload["mcpServers"]["ymcp"]["args"] == ["serve"]


def test_call_fixture_json_for_all_tools(capsys):
    for tool_name in ["plan", "ralplan", "deep_interview", "ralph", "mempalace_status", "mempalace_search"]:
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
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
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
    memory_dir = resolve_mempalace_dir(Path(tmp_path))
    assert memory_dir.exists()
    mem_config = tmp_path / ".mempalace" / "config.json"
    assert json.loads(mem_config.read_text(encoding="utf-8"))["palace_path"] == str(memory_dir)
    rules_path = project_root / ".trae" / "rules" / "ymcp-workflow-rules.md"
    assert rules_path.exists()
    output = capsys.readouterr().out
    assert "已初始化 MemPalace 记忆库" in output
    assert "已更新 Trae MCP 配置" in output
    assert "已创建/更新 Trae 项目规则" in output


def test_init_trae_can_skip_rules_and_merge_existing_json(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    config_dir = tmp_path / "User"
    config_dir.mkdir(parents=True)
    (config_dir / "mcp.json").write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}}), encoding="utf-8")
    project_root = tmp_path / "project"
    project_root.mkdir()
    memory_dir = resolve_mempalace_dir(Path(tmp_path))
    memory_dir.mkdir(parents=True)
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
    output = capsys.readouterr().out
    assert "已确认 MemPalace 记忆库目录" in output
    assert "已跳过项目规则创建" in output


def test_init_trae_overwrites_existing_rules_file_by_default(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    config_dir = tmp_path / "User"
    project_root = tmp_path / "project"
    rules_path = project_root / ".trae" / "rules" / "ymcp-workflow-rules.md"
    rules_path.parent.mkdir(parents=True)
    rules_path.write_text("# stale\n", encoding="utf-8")
    monkeypatch.setattr("builtins.input", lambda _: "y")

    assert main([
        "init-trae",
        "--config-dir", str(config_dir),
        "--project-root", str(project_root),
    ]) == 0

    assert rules_path.read_text(encoding="utf-8") != "# stale\n"
    assert "## 记忆规则" in rules_path.read_text(encoding="utf-8")


def test_init_trae_accepts_underscore_and_typo_aliases(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    for command in ["init_trae"]:
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


def test_init_trae_updates_doctor_palace_path(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    config_dir = tmp_path / "User"
    project_root = tmp_path / "project"
    project_root.mkdir()
    assert main([
        "init-trae",
        "--config-dir", str(config_dir),
        "--project-root", str(project_root),
        "--no-project-rules",
    ]) == 0
    payload = doctor_payload()
    assert payload["mempalace"]["palace_path"] == str(resolve_mempalace_dir(Path(tmp_path)))

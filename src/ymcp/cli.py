from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import platform
import shutil
import sys
from importlib import metadata
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ymcp import __version__
from ymcp.capabilities import get_prompt_specs, get_resource_specs
from ymcp.fixtures import FIXTURES, fixture_for
from ymcp.docs.template import TRAE_PROJECT_RULE_TEMPLATE
from ymcp.internal_registry import get_tool_specs
from ymcp.memory import mempalace_palace_path, mempalace_version, memory_log_kv
from ymcp.server import configure_logging, create_app



TRAE_USER_CONFIG_DIR = Path.home() / "AppData" / "Roaming" / "Trae CN" / "User"
TRAE_MCP_FILENAME = "mcp.json"
PROJECT_RULE_TEMPLATE = "trae-project-rule-template.md"
PROJECT_RULE_FILENAME = "ymcp-workflow-rules.md"
DEFAULT_MEMPALACE_DIRNAME = ".yjj"

TRAE_HOST_CONFIG = {
    "mcpServers": {
        "ymcp": {
            "command": "ymcp",
            "args": ["serve"],
            "env": {},
        }
    }
}



def resolve_trae_config_dir(config_dir: str | None = None) -> Path:
    return Path(config_dir).expanduser().resolve() if config_dir else TRAE_USER_CONFIG_DIR


def resolve_mempalace_dir(home_dir: Path | None = None) -> Path:
    base_dir = home_dir.resolve() if home_dir else Path("~").expanduser()
    return (base_dir / DEFAULT_MEMPALACE_DIRNAME).resolve()


def _mempalace_config_file(home_dir: Path | None = None) -> Path:
    base_dir = home_dir.resolve() if home_dir else Path("~").expanduser()
    return (base_dir / ".mempalace" / "config.json").resolve()


def configure_mempalace_palace_path(palace_path: Path, home_dir: Path | None = None) -> Path:
    config_path = _mempalace_config_file(home_dir)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    if config_path.exists():
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = {}
        if not isinstance(data, dict):
            data = {}
    else:
        data = {}
    data["palace_path"] = str(palace_path)
    config_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return config_path


def ensure_mempalace_initialized(home_dir: Path | None = None) -> tuple[Path, bool]:
    palace_dir = resolve_mempalace_dir(home_dir)
    configure_mempalace_palace_path(palace_dir, home_dir)
    os.environ["MEMPALACE_PALACE_PATH"] = str(palace_dir)
    if palace_dir.exists():
        return palace_dir, False
    palace_dir.mkdir(parents=True, exist_ok=True)
    mempalace_cli = importlib.import_module("mempalace.cli")
    mempalace_cli.cmd_init(SimpleNamespace(dir=str(palace_dir), yes=True, lang=None))
    return palace_dir, True


def merge_trae_mcp_config(config_path: Path) -> dict[str, Any]:
    if config_path.exists():
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Trae MCP 配置不是合法 JSON：{config_path}") from exc
        if not isinstance(data, dict):
            raise ValueError(f"Trae MCP 配置根节点必须是对象：{config_path}")
    else:
        data = {}
    mcp_servers = data.setdefault("mcpServers", {})
    if not isinstance(mcp_servers, dict):
        raise ValueError("Trae MCP 配置中的 mcpServers 必须是对象")
    mcp_servers["ymcp"] = TRAE_HOST_CONFIG["mcpServers"]["ymcp"]
    return data


def update_trae_mcp_json(config_dir: str | None = None) -> Path:
    target_dir = resolve_trae_config_dir(config_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    config_path = target_dir / TRAE_MCP_FILENAME
    data = merge_trae_mcp_config(config_path)
    config_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return config_path


def project_rule_template_text() -> str:
    return TRAE_PROJECT_RULE_TEMPLATE


def create_project_rules(project_root: str | None = None, *, overwrite: bool = True) -> Path:
    root = Path(project_root).expanduser().resolve() if project_root else Path.cwd()
    rules_dir = root / ".trae" / "rules"
    rules_dir.mkdir(parents=True, exist_ok=True)
    target = rules_dir / PROJECT_RULE_FILENAME
    if target.exists() and not overwrite:
        return target
    target.write_text(project_rule_template_text(), encoding="utf-8")
    return target


def parse_yes_no(answer: str) -> bool:
    normalized = answer.strip().lower()
    return normalized in {"y", "yes", "是", "好", "确认", "1", "true"}


def inspect_tools_payload() -> list[dict[str, Any]]:
    payload = []
    for spec in get_tool_specs():
        payload.append(
            {
                "name": spec.name,
                "description": spec.description,
                "request_schema": spec.request_model.model_json_schema(),
                "response_schema": spec.response_model.model_json_schema(),
                "schema_version": getattr(spec.response_model.model_fields["schema_version"], "default", "1.0"),
                "host_boundary": "宿主负责交互、状态、循环、执行、持久化和展示。",
            }
        )
    return payload


def inspect_resources_payload() -> list[dict[str, Any]]:
    return [
        {
            "uri": spec.uri,
            "name": spec.name,
            "title": spec.title,
            "description": spec.description,
            "mime_type": spec.mime_type,
            "primitive": "resource",
        }
        for spec in get_resource_specs()
    ]


def inspect_prompts_payload() -> list[dict[str, Any]]:
    return [
        {
            "name": spec.name,
            "title": spec.title,
            "description": spec.description,
            "arguments": list(spec.argument_names),
            "primitive": "prompt",
            "execution_boundary": "Prompt 只生成可复用调用模板，不直接执行工具，也不伪造工具结果。",
        }
        for spec in get_prompt_specs()
    ]


def inspect_capabilities_payload() -> dict[str, Any]:
    return {
        "principle": "FastMCP-first: Tools / Resources / Prompts；用户输入优先使用 MCP Elicitation。",
        "tools": inspect_tools_payload(),
        "resources": inspect_resources_payload(),
        "prompts": inspect_prompts_payload(),
    }


def doctor_payload() -> dict[str, Any]:
    python_ok = sys.version_info >= (3, 10)
    packages: dict[str, str | None] = {}
    for package_name in ("mcp", "pydantic", "mempalace"):
        try:
            packages[package_name] = metadata.version(package_name)
        except metadata.PackageNotFoundError:
            packages[package_name] = None
    ymcp_path = shutil.which("ymcp")
    ok = python_ok and all(packages.values()) and ymcp_path is not None
    return {
        "ok": ok,
        "python": {
            "version": platform.python_version(),
            "executable": sys.executable,
            "supported": python_ok,
        },
        "packages": packages,
        "ymcp_command": ymcp_path,
        "trae": {
            "recommended_config_command": "ymcp print-config --host trae",
            "project_config_path": ".trae/mcp.json",
            "note": "请在 Trae MCP 设置中手动添加该配置；如当前 Trae 版本支持项目级 .trae/mcp.json，也可使用项目级配置。",
        },
        "mempalace": {
            "version": mempalace_version(),
            "palace_path": mempalace_palace_path(),
            "default_wing": "personal",
            "default_room": "ymcp",
        },
    }


def run_fixture(tool_name: str) -> dict[str, Any]:
    specs = {spec.name: spec for spec in get_tool_specs()}
    if tool_name not in specs:
        available = ", ".join(sorted(specs))
        raise ValueError(f"未知工具 {tool_name!r}；可用工具：{available}")
    spec = specs[tool_name]
    request = spec.request_model.model_validate(fixture_for(tool_name))
    return spec.handler(request).model_dump(mode="json")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ymcp")
    parser.add_argument("--version", action="store_true", help="显示版本号并退出")
    subparsers = parser.add_subparsers(dest="command")

    serve = subparsers.add_parser("serve", help="启动 stdio MCP 服务器")
    serve.add_argument("--log-level", default="ERROR")

    inspect_cmd = subparsers.add_parser("inspect-tools", help="打印工具元数据")
    inspect_cmd.add_argument("--json", action="store_true", help="输出 JSON")

    inspect_resources_cmd = subparsers.add_parser("inspect-resources", help="打印 Resources 元数据")
    inspect_resources_cmd.add_argument("--json", action="store_true", help="输出 JSON")

    inspect_prompts_cmd = subparsers.add_parser("inspect-prompts", help="打印 Prompts 元数据")
    inspect_prompts_cmd.add_argument("--json", action="store_true", help="输出 JSON")

    inspect_capabilities_cmd = subparsers.add_parser("inspect-capabilities", help="打印 Tools / Resources / Prompts 能力元数据")
    inspect_capabilities_cmd.add_argument("--json", action="store_true", help="输出 JSON")

    doctor_cmd = subparsers.add_parser("doctor", help="检查本地 Ymcp 和 Trae MCP 准备状态")
    doctor_cmd.add_argument("--json", action="store_true", help="输出 JSON")

    config_cmd = subparsers.add_parser("print-config", help="打印 MCP 宿主配置")
    config_cmd.add_argument("--host", choices=["trae"], default="trae")

    init_trae_cmd = subparsers.add_parser(
        "init-trae",
        aliases=["init_trae"],
        help="初始化 Trae 用户级 MCP 配置，并可创建项目规则",
    )
    init_trae_cmd.add_argument("--config-dir", help="Trae 用户配置目录；默认是当前用户的 AppData/Roaming/Trae CN/User")
    init_trae_cmd.add_argument("--project-root", help="项目根目录；默认是当前工作目录")
    init_trae_cmd.add_argument("--yes-project-rules", action="store_true", help="不询问，直接创建项目规则")
    init_trae_cmd.add_argument("--no-project-rules", action="store_true", help="不询问，跳过项目规则创建")
    init_trae_cmd.add_argument(
        "--overwrite-rules",
        action="store_true",
        help="兼容旧参数；当前创建项目规则时默认会覆盖写入",
    )

    fixture_cmd = subparsers.add_parser("call-fixture", help="调用内置确定性示例")
    fixture_cmd.add_argument("tool", choices=sorted(FIXTURES))
    fixture_cmd.add_argument("--json", action="store_true", help="输出 JSON")

    args = parser.parse_args(argv)

    if args.version:
        print(__version__)
        return 0

    if args.command == "inspect-tools":
        payload = inspect_tools_payload()
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            for item in payload:
                print(f"{item['name']}: {item['description']}")
        return 0

    if args.command == "inspect-resources":
        payload = inspect_resources_payload()
        if args.json:
            print(json.dumps(payload, indent=2, ensure_ascii=False))
        else:
            for item in payload:
                print(f"{item['uri']}: {item['description']}")
        return 0

    if args.command == "inspect-prompts":
        payload = inspect_prompts_payload()
        if args.json:
            print(json.dumps(payload, indent=2, ensure_ascii=False))
        else:
            for item in payload:
                print(f"{item['name']}: {item['description']}")
        return 0

    if args.command == "inspect-capabilities":
        payload = inspect_capabilities_payload()
        if args.json:
            print(json.dumps(payload, indent=2, ensure_ascii=False))
        else:
            print(payload["principle"])
            print(f"Tools: {len(payload['tools'])}")
            print(f"Resources: {len(payload['resources'])}")
            print(f"Prompts: {len(payload['prompts'])}")
        return 0

    if args.command == "doctor":
        payload = doctor_payload()
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            status = "正常" if payload["ok"] else "发现问题"
            print(f"Ymcp 诊断：{status}")
            print(f"Python: {payload['python']['version']} ({payload['python']['executable']})")
            print(f"ymcp 命令：{payload['ymcp_command'] or '未在 PATH 中找到'}")
            for package_name, version in payload["packages"].items():
                print(f"{package_name}: {version or '未安装'}")
            print("Trae 配置：运行 `ymcp print-config --host trae`")
        return 0 if payload["ok"] else 1

    if args.command == "print-config":
        print(json.dumps(TRAE_HOST_CONFIG, indent=2))
        return 0


    if args.command in {"init-trae", "init_trae"}:
        if args.yes_project_rules and args.no_project_rules:
            parser.error("--yes-project-rules 和 --no-project-rules 不能同时使用")
        palace_path, palace_initialized = ensure_mempalace_initialized()
        if palace_initialized:
            print(f"已初始化 MemPalace 记忆库：{palace_path}")
        else:
            print(f"已确认 MemPalace 记忆库目录：{palace_path}")
        config_path = update_trae_mcp_json(args.config_dir)
        print(f"已更新 Trae MCP 配置：{config_path}")
        should_create_rules = args.yes_project_rules
        if not args.yes_project_rules and not args.no_project_rules:
            answer = input("是否在当前项目的 .trae/rules/ 下创建 Ymcp 项目规则？[y/N] ")
            should_create_rules = parse_yes_no(answer)
        if should_create_rules:
            rule_path = create_project_rules(args.project_root, overwrite=True)
            print(f"已创建/更新 Trae 项目规则：{rule_path}")
        else:
            print("已跳过项目规则创建。")
        return 0

    if args.command == "call-fixture":
        payload = run_fixture(args.tool)
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(f"{args.tool}: {payload['status']}")
            print(payload["summary"])
        return 0

    if args.command == "serve":
        level = getattr(logging, str(args.log_level).upper(), logging.ERROR)
        configure_logging(level)
        memory_log_kv(
            "ymcp_serve_start",
            pid=os.getpid(),
            ymcp_version=__version__,
            python=sys.executable,
            mempalace_version=mempalace_version(),
            palace_path=mempalace_palace_path(),
            log_level=str(args.log_level).upper(),
        )
        create_app().run(transport="stdio")
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



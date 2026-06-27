from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import platform
import shutil
import sys
import time
from importlib import metadata
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ymcp import __version__
from ymcp.capabilities import get_prompt_specs, get_resource_specs
from ymcp.fixtures import FIXTURES, fixture_for
from ymcp.docs.template import TRAE_PROJECT_RULE_TEMPLATE
from ymcp.internal_registry import get_tool_specs
from ymcp.tools.imagegen.local_frame_workflow import (
    extract_video_frames,
    framesheet_to_gif,
    framesheet_to_webp,
    parse_key_color,
    remove_chroma_key,
    resize_framesheet,
)
from ymcp.memory import DEFAULT_MEMORY_ROOM, DEFAULT_MEMORY_WING, mempalace_palace_path, mempalace_version, memory_log_kv
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


PNG_SUFFIXES = {".png"}
NOBG_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
PILLOW_INSTALL_HINT = 'Install with `pip install "ymcp[imagegen]"`.'
NOBG_DEFAULT_CUT = 12
NOBG_DEFAULT_KEEP = 48


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
            "default_wing": DEFAULT_MEMORY_WING,
            "default_room": DEFAULT_MEMORY_ROOM,
            "wing_resolution": "wing → project_id → project_root → YMCP_DEFAULT_WING → personal",
        },
    }


def _load_cli_pillow():
    try:
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - only exercised without optional dependency
        raise RuntimeError(f"Pillow is required for image batch commands. {PILLOW_INSTALL_HINT}") from exc
    return Image


def _current_dir_files_with_suffixes(suffixes: set[str]) -> list[Path]:
    return sorted(path for path in Path.cwd().iterdir() if path.is_file() and path.suffix.lower() in suffixes)


def _resolve_batch_output_dir(default_suffix: str, out_dir: str | None = None) -> Path:
    if out_dir:
        output_dir = Path(out_dir).expanduser().resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        return output_dir

    cwd = Path.cwd().resolve()
    base = cwd / f"{cwd.name}-{default_suffix}"
    candidate = base
    index = 2
    while candidate.exists():
        candidate = cwd / f"{cwd.name}-{default_suffix}-{index}"
        index += 1
    candidate.mkdir(parents=True)
    return candidate


def _resolve_image_batch_output_root(default_suffix: str, source_count: int, out_dir: str | None = None) -> Path:
    if out_dir or source_count > 1:
        return _resolve_batch_output_dir(default_suffix, out_dir)
    return Path.cwd().resolve()


def _ensure_can_write_output(path: Path, *, overwrite: bool) -> None:
    if path.exists() and not overwrite:
        raise FileExistsError(f"output already exists: {path}")


def to_jpg_command(*, out_dir: str | None = None, overwrite: bool = True, background: str = "#ffffff") -> tuple[Path, int]:
    Image = _load_cli_pillow()
    background_rgb = parse_key_color(background)
    sources = _current_dir_files_with_suffixes(PNG_SUFFIXES)
    if not sources:
        raise ValueError(f"no PNG files found in {Path.cwd()}")

    output_dir = Path(out_dir).expanduser().resolve() if out_dir else Path.cwd().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []
    converted = 0
    for source in sources:
        target = output_dir / f"{source.stem}.jpg"
        try:
            _ensure_can_write_output(target, overwrite=overwrite)
            with Image.open(source) as image:
                rgba = image.convert("RGBA")
            background_image = Image.new("RGBA", rgba.size, (*background_rgb, 255))
            background_image.alpha_composite(rgba)
            background_image.convert("RGB").save(target, format="JPEG", quality=95, subsampling=0)
            source.unlink()
            converted += 1
        except Exception as exc:  # noqa: BLE001 - report all per-file image failures together
            failures.append(f"{source.name}: {exc}")

    if failures:
        raise RuntimeError("; ".join(failures))
    return output_dir, converted


def nobg_command(
    *,
    out_dir: str | None = None,
    overwrite: bool = True,
    cut: int = NOBG_DEFAULT_CUT,
    keep: int | None = None,
    auto_key: str = "border",
) -> tuple[Path, int]:
    _load_cli_pillow()
    if keep is not None and keep <= cut:
        raise ValueError("--keep must be greater than --cut")
    sources = _current_dir_files_with_suffixes(NOBG_IMAGE_SUFFIXES)
    if not sources:
        raise ValueError(f"no supported image files found in {Path.cwd()}")

    output_dir = _resolve_image_batch_output_root("nobg", len(sources), out_dir)
    failures: list[str] = []
    converted = 0
    for source in sources:
        target = output_dir / f"{source.stem}.png"
        if target.resolve() == source.resolve():
            target = output_dir / f"{source.stem}-nobg.png"
        try:
            _ensure_can_write_output(target, overwrite=overwrite)
            keep_threshold = keep if keep is not None else NOBG_DEFAULT_KEEP if cut == NOBG_DEFAULT_CUT else min(255, cut + 32)
            soft_matte = cut < keep_threshold
            remove_chroma_key(
                source,
                target,
                auto_key=auto_key,
                tolerance=cut,
                soft_matte=soft_matte,
                transparent_threshold=cut,
                opaque_threshold=keep_threshold,
            )
            converted += 1
        except Exception as exc:  # noqa: BLE001 - report all per-file image failures together
            failures.append(f"{source.name}: {exc}")

    if failures:
        raise RuntimeError("; ".join(failures))
    return output_dir, converted


def frame_command(grid: str, image_path: str, *, out: str | None = None, size: int = 256, overwrite: bool = True) -> Path:
    return resize_framesheet(image_path, grid, out, frame_size=size, overwrite=overwrite)


def frame_gif_command(grid: str, image_path: str, *, out: str | None = None, duration: int = 80, loop: int = 0, size: int | None = None, overwrite: bool = True) -> Path:
    return framesheet_to_gif(image_path, grid, out, duration_ms=duration, loop=loop, frame_size=size, overwrite=overwrite)


def frame_webp_command(
    grid: str,
    image_path: str,
    *,
    out: str | None = None,
    duration: int = 80,
    loop: int = 0,
    size: int | None = None,
    overwrite: bool = True,
    lossless: bool = True,
) -> Path:
    return framesheet_to_webp(
        image_path,
        grid,
        out,
        duration_ms=duration,
        loop=loop,
        frame_size=size,
        overwrite=overwrite,
        lossless=lossless,
    )


def video_frames_command(
    count: int,
    video: str,
    *,
    out: str | None = None,
    size: str | None = None,
    seconds: str | None = None,
    overwrite: bool = True,
    remove_background: bool = True,
    background_tolerance: int = 12,
    columns: int | None = None,
    duration: int | None = None,
    loop: int = 0,
    lossless: bool = True,
    fade: str | None = "default",
) -> Path:
    return extract_video_frames(
        video,
        count,
        out,
        seconds=seconds,
        size=size,
        overwrite=overwrite,
        remove_background=remove_background,
        background_tolerance=background_tolerance,
        columns=columns,
        duration_ms=duration,
        loop=loop,
        lossless=lossless,
        fade=fade,
    )


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

    to_jpg_cmd = subparsers.add_parser("to-jpg", aliases=["to_jpg"], help="将当前目录直属 PNG 图片批量转换为 JPG")
    to_jpg_cmd.add_argument("--out-dir", help="输出目录；默认输出到当前目录，并在成功转换后删除源 PNG")
    to_jpg_cmd.add_argument("--no-overwrite", action="store_true", help="如果目标文件已存在则失败；默认覆盖输出目录内同名文件")
    to_jpg_cmd.add_argument("--background", default="#ffffff", help="透明 PNG 转 JPG 时使用的铺底色，格式 #RRGGBB；默认 #ffffff")

    nobg_cmd = subparsers.add_parser("nobg", help="将当前目录直属图片批量去背景并输出透明 PNG")
    nobg_cmd.add_argument("--out-dir", help="输出目录；多图默认在当前目录下创建 <当前文件夹名>-nobg，单图默认输出到当前目录")
    nobg_cmd.add_argument("--no-overwrite", action="store_true", help="如果目标文件已存在则失败；默认覆盖输出目录内同名文件")
    nobg_cmd.add_argument("--cut", "--tol", "--tolerance", dest="cut", type=int, default=NOBG_DEFAULT_CUT, help=f"完全扣掉的背景色距离阈值，0-255；默认 {NOBG_DEFAULT_CUT}")
    nobg_cmd.add_argument("--keep", type=int, help=f"完全保留的背景色距离阈值，必须大于 --cut；默认 {NOBG_DEFAULT_KEEP}，显式 --cut 时默认是 --cut + 32")
    nobg_cmd.add_argument("--auto-key", choices=["border", "corners"], default="border", help="自动取样背景色的位置；默认 border")

    frame_cmd = subparsers.add_parser("frame", help="将 framesheet 按 COLSxROWS 网格重采样为每帧固定尺寸")
    frame_cmd.add_argument("grid", help="网格，格式为 COLSxROWS，例如 4x4")
    frame_cmd.add_argument("image", help="输入 framesheet 图片路径")
    frame_cmd.add_argument("--out", help="输出 PNG 路径；默认在同目录生成 <name>-256.png")
    frame_cmd.add_argument("--size", type=int, default=256, help="每帧目标边长；默认 256")
    frame_cmd.add_argument("--no-overwrite", action="store_true", help="如果输出文件已存在则失败；默认覆盖")

    frame_gif_cmd = subparsers.add_parser("frame-gif", help="将 framesheet 按 COLSxROWS 网格合成为 GIF")
    frame_gif_cmd.add_argument("grid", help="网格，格式为 COLSxROWS，例如 4x4")
    frame_gif_cmd.add_argument("image", help="输入 framesheet 图片路径")
    frame_gif_cmd.add_argument("--out", help="输出 GIF 路径；默认在同目录生成 <name>.gif")
    frame_gif_cmd.add_argument("--duration", type=int, default=80, help="每帧持续毫秒数；默认 80")
    frame_gif_cmd.add_argument("--loop", type=int, default=0, help="循环次数；默认 0 表示无限循环")
    frame_gif_cmd.add_argument("--size", type=int, help="可选：每帧输出边长，不传则使用原格尺寸")
    frame_gif_cmd.add_argument("--no-overwrite", action="store_true", help="如果输出文件已存在则失败；默认覆盖")

    frame_webp_cmd = subparsers.add_parser("frame-webp", aliases=["frame_webp"], help="将 framesheet 按 COLSxROWS 网格合成为 WebP 动画")
    frame_webp_cmd.add_argument("grid", help="网格，格式为 COLSxROWS，例如 4x4")
    frame_webp_cmd.add_argument("image", help="输入 framesheet 图片路径")
    frame_webp_cmd.add_argument("--out", help="输出 WebP 路径；默认在同目录生成 <name>.webp")
    frame_webp_cmd.add_argument("--duration", type=int, default=80, help="每帧持续毫秒数；默认 80")
    frame_webp_cmd.add_argument("--loop", type=int, default=0, help="循环次数；默认 0 表示无限循环")
    frame_webp_cmd.add_argument("--size", type=int, help="可选：每帧输出边长，不传则使用原格尺寸")
    frame_webp_cmd.add_argument("--lossy", action="store_true", help="使用有损 WebP；默认 lossless 以保留透明边缘质量")
    frame_webp_cmd.add_argument("--no-overwrite", action="store_true", help="如果输出文件已存在则失败；默认覆盖")

    video_frames_cmd = subparsers.add_parser("v2f", aliases=["video-frames", "video_frames"], help="均匀抓取视频 N 帧，扣背景后生成 framesheet 和 WebP")
    video_frames_cmd.add_argument("count", type=int, help="要抓取的帧数")
    video_frames_cmd.add_argument("video", help="视频路径或 ffmpeg 可读取的视频 URL")
    video_frames_cmd.add_argument("--out", help="输出目录；默认当前目录下 ./video_frames")
    video_frames_cmd.add_argument("--size", default="256", help="单帧尺寸：默认 256；full 为原分辨率；也可用 512 或 320x180")
    video_frames_cmd.add_argument("--seconds", help="使用的视频秒数：2 表示 0-2 秒；1-2 表示 1-2 秒；默认使用完整视频")
    video_frames_cmd.add_argument("--remove-bg", "--remove-background", dest="remove_bg", action="store_true", default=True, help="扣除背景：用第一帧中出现最多的颜色作为背景色，并复用于所有帧；默认开启")
    video_frames_cmd.add_argument("--keep-bg", dest="remove_bg", action="store_false", help="保留背景，不执行扣背景")
    video_frames_cmd.add_argument("--bg-tolerance", type=int, default=12, help="扣背景颜色容差，0-255；默认 12")
    video_frames_cmd.add_argument("--columns", type=int, help="framesheet 列数；默认尽量接近方形，例如 24 帧为 4x6，20 帧为 4x5")
    video_frames_cmd.add_argument("--duration", type=int, help="WebP 每帧持续毫秒数；默认按选中视频片段时长/帧数计算")
    video_frames_cmd.add_argument("--loop", type=int, default=0, help="WebP 循环次数；默认 0 表示无限循环")
    video_frames_cmd.add_argument("--lossy", action="store_true", help="使用有损 WebP；默认 lossless")
    video_frames_cmd.add_argument("--fade", nargs="?", const="default", default="default", help="径向透明淡出：默认 80%% 半径内不透明并线性淡出；可用 80 或 80-2 调整百分比和衰减速度")
    video_frames_cmd.add_argument("--no-overwrite", action="store_true", help="如果 framesheet.png 或 animation.webp 已存在则失败；默认覆盖")

    web_cmd = subparsers.add_parser(
        "web",
        aliases=["v2f-ui", "v2f_ui"],
        help="启动本地网页工作台（单用户、localhost 默认）",
        description="启动本地网页工作台（单用户、localhost 默认）",
    )
    web_cmd.add_argument("--host", default="127.0.0.1", help="监听地址；默认 127.0.0.1。非本机地址不代表多用户/云端支持")
    web_cmd.add_argument("--port", type=int, default=0, help="监听端口；默认 0 表示自动选择可用端口")
    web_cmd.add_argument("--work-dir", help="工作/导出根目录；默认当前启动目录下的 v2f-ui-output")
    web_cmd.add_argument("--no-open", action="store_true", help="不自动打开浏览器")

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

    if args.command in {"to-jpg", "to_jpg"}:
        try:
            output_dir, count = to_jpg_command(out_dir=args.out_dir, overwrite=not args.no_overwrite, background=args.background)
        except Exception as exc:
            print(f"to-jpg failed: {exc}", file=sys.stderr)
            return 1
        print(f"{output_dir} ({count} files)")
        return 0

    if args.command == "nobg":
        try:
            output_dir, count = nobg_command(out_dir=args.out_dir, overwrite=not args.no_overwrite, cut=args.cut, keep=args.keep, auto_key=args.auto_key)
        except Exception as exc:
            print(f"nobg failed: {exc}", file=sys.stderr)
            return 1
        print(f"{output_dir} ({count} files)")
        return 0

    if args.command == "frame":
        try:
            output = frame_command(args.grid, args.image, out=args.out, size=args.size, overwrite=not args.no_overwrite)
        except Exception as exc:
            print(f"frame failed: {exc}", file=sys.stderr)
            return 1
        print(output)
        return 0

    if args.command == "frame-gif":
        try:
            output = frame_gif_command(args.grid, args.image, out=args.out, duration=args.duration, loop=args.loop, size=args.size, overwrite=not args.no_overwrite)
        except Exception as exc:
            print(f"frame-gif failed: {exc}", file=sys.stderr)
            return 1
        print(output)
        return 0

    if args.command in {"frame-webp", "frame_webp"}:
        try:
            output = frame_webp_command(
                args.grid,
                args.image,
                out=args.out,
                duration=args.duration,
                loop=args.loop,
                size=args.size,
                overwrite=not args.no_overwrite,
                lossless=not args.lossy,
            )
        except Exception as exc:
            print(f"frame-webp failed: {exc}", file=sys.stderr)
            return 1
        print(output)
        return 0

    if args.command in {"v2f", "video-frames", "video_frames"}:
        try:
            output = video_frames_command(
                args.count,
                args.video,
                out=args.out,
                size=args.size,
                seconds=args.seconds,
                overwrite=not args.no_overwrite,
                remove_background=args.remove_bg,
                background_tolerance=args.bg_tolerance,
                columns=args.columns,
                duration=args.duration,
                loop=args.loop,
                lossless=not args.lossy,
                fade=args.fade,
            )
        except Exception as exc:
            print(f"v2f failed: {exc}", file=sys.stderr)
            return 1
        print(output)
        return 0

    if args.command in {"web", "v2f-ui", "v2f_ui"}:
        try:
            from ymcp.web.v2f_app import run_v2f_editor

            server, url = run_v2f_editor(host=args.host, port=args.port, open_browser=not args.no_open, work_dir=args.work_dir)
            print(f"Ymcp web workbench running at {url}")
            print(f"Output root: {server.v2f_output_root}")  # type: ignore[attr-defined]
            print("Press Ctrl+C to stop. This is a local single-user web workbench, not a multi-user/cloud service.")
            try:
                while True:
                    time.sleep(3600)
            except KeyboardInterrupt:
                server.shutdown()
                server.server_close()
                print("Ymcp web workbench stopped.")
            return 0
        except Exception as exc:
            print(f"web failed: {exc}", file=sys.stderr)
            return 1

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



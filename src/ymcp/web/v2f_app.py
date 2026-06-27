"""Stdlib local web app for the Ymcp v2f editor."""

from __future__ import annotations

import base64
import json
import mimetypes
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from ymcp.tools.imagegen.session import V2FSessionStore
from ymcp.tools.imagegen.timing import SpeedKeyframe, TimingMapSpec, TimingPoint, timing_from_speed_keyframes, timing_preset
from ymcp.tools.imagegen.v2f_core import CapturePlan, ExportSpec, VisualPipelineSpec
from ymcp.web.v2f_static import INDEX_HTML


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _bytes_response(handler: BaseHTTPRequestHandler, status: int, body: bytes, content_type: str) -> None:
    handler.send_response(status)
    handler.send_header("content-type", content_type)
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _file_response(handler: BaseHTTPRequestHandler, path, content_type: str | None = None) -> None:
    data = path.read_bytes()
    total = len(data)
    range_header = handler.headers.get("Range")
    mime = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    if range_header and range_header.startswith("bytes="):
        raw_start, _, raw_end = range_header.removeprefix("bytes=").partition("-")
        start = int(raw_start) if raw_start else 0
        end = int(raw_end) if raw_end else total - 1
        start = max(0, min(start, total - 1))
        end = max(start, min(end, total - 1))
        chunk = data[start : end + 1]
        handler.send_response(206)
        handler.send_header("content-type", mime)
        handler.send_header("accept-ranges", "bytes")
        handler.send_header("content-range", f"bytes {start}-{end}/{total}")
        handler.send_header("content-length", str(len(chunk)))
        handler.end_headers()
        handler.wfile.write(chunk)
        return
    handler.send_response(200)
    handler.send_header("content-type", mime)
    handler.send_header("accept-ranges", "bytes")
    handler.send_header("content-length", str(total))
    handler.end_headers()
    handler.wfile.write(data)


def _visual_from_payload(payload: dict[str, Any]) -> VisualPipelineSpec:
    output_size = payload.get("output_size")
    return VisualPipelineSpec(
        remove_background=bool(payload.get("remove_background", True)),
        background_tolerance=int(payload.get("background_tolerance", 12)),
        key_color=tuple(payload["key_color"]) if payload.get("key_color") else None,  # type: ignore[arg-type]
        crop=tuple(payload["crop"]) if payload.get("crop") else None,  # type: ignore[arg-type]
        output_size=tuple(output_size) if output_size else None,  # type: ignore[arg-type]
        fade=payload.get("fade", "default"),
    )


def _timing_from_payload(payload: dict[str, Any]) -> TimingMapSpec:
    if payload.get("speed_keyframes"):
        keyframes = tuple(
            SpeedKeyframe(
                time_seconds=float(item.get("time", item.get("time_seconds"))),
                before_speed=float(item.get("before", item.get("before_speed"))),
                after_speed=float(item.get("after", item.get("after_speed"))),
            )
            for item in payload["speed_keyframes"]
        )
        return timing_from_speed_keyframes(float(payload["duration_seconds"]), keyframes)
    if payload.get("preset"):
        return timing_preset(str(payload["preset"]))
    points = tuple(TimingPoint(float(item[0]), float(item[1])) for item in payload.get("points", [[0, 0], [1, 1]]))
    return TimingMapSpec(points=points)


def create_v2f_app(store: V2FSessionStore | None = None) -> type[BaseHTTPRequestHandler]:
    sessions = store or V2FSessionStore()

    class V2FHandler(BaseHTTPRequestHandler):
        server_version = "YmcpV2FEditor/1.0"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

        def _read_json(self) -> dict[str, Any]:
            raw = self.rfile.read(int(self.headers.get("content-length", "0") or "0"))
            return json.loads(raw.decode("utf-8")) if raw else {}

        def do_GET(self) -> None:  # noqa: N802
            try:
                parsed = urlparse(self.path)
                parts = [unquote(part) for part in parsed.path.strip("/").split("/") if part]
                if parsed.path in {"", "/"}:
                    _bytes_response(self, 200, INDEX_HTML.encode("utf-8"), "text/html; charset=utf-8")
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "status":
                    _json_response(self, 200, sessions.status(parts[2]))
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "cache":
                    _json_response(self, 200, sessions.cache_summary(parts[2]))
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "preview":
                    path = sessions.render_preview(parts[2])
                    _json_response(self, 200, {"path": str(path), "url": f"/api/sessions/{parts[2]}/artifact/preview"})
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "preview-frames":
                    query = parse_qs(parsed.query)
                    fps = max(1, min(60, int(float(query.get("fps", ["12"])[0]))))
                    paths = sessions.render_preview_sequence(parts[2])
                    _json_response(
                        self,
                        200,
                        {
                            "fps": fps,
                            "frame_count": len(paths),
                            "frames": [f"/api/sessions/{parts[2]}/artifact/preview-frame-{index}" for index in range(len(paths))],
                        },
                    )
                    return
                if len(parts) == 5 and parts[:2] == ["api", "sessions"] and parts[3] == "artifact":
                    session = sessions.get(parts[2])
                    artifact_name = parts[4]
                    path = session.preview_path if artifact_name == "preview" else None
                    if artifact_name.startswith("preview-frame-"):
                        try:
                            frame_index = int(artifact_name.removeprefix("preview-frame-"))
                        except ValueError:
                            frame_index = -1
                        if 0 <= frame_index < len(session.preview_frame_paths):
                            path = session.preview_frame_paths[frame_index]
                    if path is None or not path.exists():
                        _json_response(self, 404, {"error": "未找到产物"})
                        return
                    session_root = session.temp_root.resolve()
                    resolved = path.resolve()
                    if resolved != session_root and session_root not in resolved.parents:
                        _json_response(self, 403, {"error": "产物路径不在当前会话目录内"})
                        return
                    content_type = "image/webp" if artifact_name == "preview" else "image/png"
                    _bytes_response(self, 200, resolved.read_bytes(), content_type)
                    return
                if len(parts) == 3 and parts[:2] == ["api", "uploads"]:
                    upload_path = sessions.upload_root / parts[2]
                    if not upload_path.exists():
                        _json_response(self, 404, {"error": "未找到上传文件"})
                        return
                    resolved = upload_path.resolve()
                    upload_root = sessions.upload_root.resolve()
                    if resolved != upload_root and upload_root not in resolved.parents:
                        _json_response(self, 403, {"error": "上传文件路径不在上传目录内"})
                        return
                    _file_response(self, resolved)
                    return
                _json_response(self, 404, {"error": "未找到请求的资源"})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})

        def do_POST(self) -> None:  # noqa: N802
            try:
                parts = [unquote(part) for part in urlparse(self.path).path.strip("/").split("/") if part]
                payload = self._read_json()
                if parts == ["api", "uploads"]:
                    raw = base64.b64decode(payload["data_base64"], validate=True)
                    path = sessions.save_upload(str(payload.get("filename", "upload.bin")), raw)
                    _json_response(self, 200, {"path": str(path), "url": f"/api/uploads/{path.name}", "size": len(raw)})
                    return
                if parts == ["api", "sessions"]:
                    if payload.get("kind") == "framesheet":
                        session = sessions.create_from_framesheet(payload["source"], payload["grid"])
                    else:
                        session = sessions.create_empty()
                    _json_response(self, 200, session.to_dict())
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "capture":
                    plan = CapturePlan(
                        source=payload["source"],
                        count=int(payload["count"]),
                        seconds=payload.get("seconds"),
                        decode_size=payload.get("decode_size"),
                        crop=tuple(payload["crop"]) if payload.get("crop") else None,  # type: ignore[arg-type]
                    )
                    _json_response(self, 200, sessions.capture_video(parts[2], plan).to_dict())
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "export":
                    export = ExportSpec(
                        columns=payload.get("columns"),
                        duration_ms=int(payload.get("duration_ms", 80)),
                        loop=int(payload.get("loop", 0)),
                        lossless=bool(payload.get("lossless", True)),
                    )
                    export_format = str(payload.get("format", "bundle"))
                    if export_format == "framesheet":
                        out = sessions.export_framesheet(parts[2], payload.get("out_dir"), export)
                        _json_response(self, 200, {"format": "framesheet", "path": str(out), "framesheet": str(out)})
                    elif export_format == "webp":
                        out = sessions.export_webp(parts[2], payload.get("out_dir"), export)
                        _json_response(self, 200, {"format": "webp", "path": str(out), "animation": str(out)})
                    elif export_format == "gif":
                        out = sessions.export_gif(parts[2], payload.get("out_dir"), export)
                        _json_response(self, 200, {"format": "gif", "path": str(out), "animation": str(out)})
                    else:
                        out = sessions.export(parts[2], payload.get("out_dir"), export)
                        _json_response(self, 200, {"format": "bundle", "path": str(out), "framesheet": str(out / "framesheet.png"), "animation": str(out / "animation.webp")})
                    return
                _json_response(self, 404, {"error": "未找到请求的资源"})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})

        def do_PATCH(self) -> None:  # noqa: N802
            try:
                parts = [unquote(part) for part in urlparse(self.path).path.strip("/").split("/") if part]
                payload = self._read_json()
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "visual":
                    _json_response(self, 200, sessions.update_visual(parts[2], _visual_from_payload(payload)).to_dict())
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "timing":
                    session = sessions.update_timing(parts[2], _timing_from_payload(payload))
                    _json_response(self, 200, sessions.status(session.id))
                    return
                _json_response(self, 404, {"error": "未找到请求的资源"})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})

        def do_DELETE(self) -> None:  # noqa: N802
            try:
                parts = [unquote(part) for part in urlparse(self.path).path.strip("/").split("/") if part]
                if len(parts) == 3 and parts[:2] == ["api", "sessions"]:
                    sessions.reset(parts[2])
                    _json_response(self, 200, {"deleted": True})
                    return
                _json_response(self, 404, {"error": "未找到请求的资源"})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})

    return V2FHandler


def run_v2f_editor(
    host: str = "127.0.0.1",
    port: int = 0,
    *,
    open_browser: bool = True,
    work_dir: str | Path | None = None,
) -> tuple[ThreadingHTTPServer, str]:
    output_root = Path(work_dir).expanduser().resolve() if work_dir is not None else (Path.cwd() / "v2f-ui-output").resolve()
    handler = create_v2f_app(V2FSessionStore(export_root=output_root))
    server = ThreadingHTTPServer((host, port), handler)
    url = f"http://{server.server_address[0]}:{server.server_address[1]}/"
    server.v2f_output_root = output_root  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    if open_browser:
        webbrowser.open(url)
    return server, url


__all__ = ["create_v2f_app", "run_v2f_editor"]

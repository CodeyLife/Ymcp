from http.client import HTTPConnection
import base64
import json
import threading
from pathlib import Path

import pytest

Image = pytest.importorskip("PIL.Image")

from http.server import ThreadingHTTPServer

from ymcp.tools.imagegen.session import V2FSessionStore
from ymcp.web.v2f_app import create_v2f_app


def _request(server, method, path, payload=None):
    conn = HTTPConnection(server.server_address[0], server.server_address[1], timeout=5)
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"content-type": "application/json"} if body is not None else {}
    conn.request(method, path, body=body, headers=headers)
    response = conn.getresponse()
    raw = response.read()
    conn.close()
    return response.status, json.loads(raw.decode("utf-8"))


@pytest.fixture
def v2f_server(tmp_path, monkeypatch):
    def fake_webp(frames, out, *, duration_ms, loop=0, lossless=True):
        out.parent.mkdir(parents=True, exist_ok=True)
        frames[0].save(out, save_all=True, append_images=frames[1:], duration=duration_ms, loop=loop, lossless=lossless)
        return out

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow._save_webp_animation_with_ffmpeg", fake_webp)
    monkeypatch.setattr("ymcp.tools.imagegen.session._save_webp_animation_with_ffmpeg", fake_webp)
    store = V2FSessionStore(tmp_path / "sessions")
    server = ThreadingHTTPServer(("127.0.0.1", 0), create_v2f_app(store))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        store.close()


def test_v2f_web_app_framesheet_session_visual_timing_and_preview(v2f_server, tmp_path):
    sheet = tmp_path / "sheet.png"
    image = Image.new("RGBA", (20, 10), (0, 0, 0, 0))
    for x in range(10):
        for y in range(10):
            image.putpixel((x, y), (255, 0, 0, 255))
            image.putpixel((x + 10, y), (0, 255, 0, 255))
    image.save(sheet)

    status, payload = _request(v2f_server, "POST", "/api/sessions", {"kind": "framesheet", "source": str(sheet), "grid": "2x1"})
    assert status == 200
    session_id = payload["id"]
    assert payload["source_kind"] == "framesheet"

    status, payload = _request(v2f_server, "PATCH", f"/api/sessions/{session_id}/visual", {"remove_background": False, "fade": "100"})
    assert status == 200

    status, payload = _request(v2f_server, "PATCH", f"/api/sessions/{session_id}/timing", {"preset": "hold_then_burst"})
    assert status == 200
    assert payload["timing_spec"]["preset"] == "hold_then_burst"

    status, payload = _request(v2f_server, "GET", f"/api/sessions/{session_id}/preview")
    assert status == 200
    assert payload["url"] == f"/api/sessions/{session_id}/artifact/preview"

    status, payload = _request(v2f_server, "POST", f"/api/sessions/{session_id}/export", {"duration_ms": 40})
    assert status == 200
    assert Path(payload["framesheet"]).exists()
    assert Path(payload["animation"]).exists()

    status, payload = _request(v2f_server, "POST", f"/api/sessions/{session_id}/export", {"format": "framesheet"})
    assert status == 200
    assert payload["format"] == "framesheet"
    assert Path(payload["framesheet"]).name == "framesheet.png"

    status, payload = _request(v2f_server, "POST", f"/api/sessions/{session_id}/export", {"format": "webp"})
    assert status == 200
    assert payload["format"] == "webp"
    assert Path(payload["animation"]).name == "animation.webp"

    status, payload = _request(v2f_server, "POST", f"/api/sessions/{session_id}/export", {"format": "gif"})
    assert status == 200
    assert payload["format"] == "gif"
    assert Path(payload["animation"]).name == "animation.gif"


def test_v2f_web_app_index_uses_chinese_ui_text(v2f_server):
    conn = HTTPConnection(v2f_server.server_address[0], v2f_server.server_address[1], timeout=5)
    conn.request("GET", "/")
    response = conn.getresponse()
    html = response.read().decode("utf-8")
    conn.close()

    assert response.status == 200
    assert "Ymcp v2f 编辑器" in html
    assert "素材来源" in html
    assert "拖拽视频或帧表到这里" in html
    assert "中心不透明半径（%）" in html
    assert "边缘衰减速度" in html
    assert "淡出预设" in html
    assert "透明淡出：中心 80% 保持不透明" in html
    assert "节奏模板" in html
    assert "蓄力时长（%）" in html
    assert "停顿强度（%）" in html
    assert "爆发位置（%）" in html
    assert "高级模式" in html
    assert "应用节奏" in html
    assert "可编辑关键点 JSON" not in html
    assert "创建并抽帧" in html
    assert "生成预览" in html
    assert "导出帧表" in html
    assert "导出 WebP" in html
    assert "导出 GIF" in html
    assert "Visual + Timing" not in html
    assert "Create / Capture" not in html


def test_v2f_web_app_upload_saves_file_under_upload_root(v2f_server):
    status, payload = _request(
        v2f_server,
        "POST",
        "/api/uploads",
        {"filename": "../clip.mp4", "data_base64": base64.b64encode(b"fake-video").decode("ascii")},
    )

    assert status == 200
    path = Path(payload["path"])
    assert path.exists()
    assert path.name.endswith("-clip.mp4")
    assert path.read_bytes() == b"fake-video"


def test_v2f_web_app_rejects_export_outside_session_root(v2f_server, tmp_path):
    sheet = tmp_path / "sheet.png"
    Image.new("RGBA", (10, 10), (255, 0, 0, 255)).save(sheet)
    status, payload = _request(v2f_server, "POST", "/api/sessions", {"kind": "framesheet", "source": str(sheet), "grid": "1x1"})
    assert status == 200

    status, payload = _request(v2f_server, "POST", f"/api/sessions/{payload['id']}/export", {"out_dir": str(tmp_path / "outside")})
    assert status == 400
    assert "路径必须位于" in payload["error"]


def test_v2f_web_app_video_render_changes_do_not_recapture(tmp_path, monkeypatch):
    calls = []
    sheet = tmp_path / "sheet.png"
    image = Image.new("RGBA", (20, 10), (0, 0, 0, 0))
    for x in range(10):
        for y in range(10):
            image.putpixel((x, y), (255, 0, 0, 255))
            image.putpixel((x + 10, y), (0, 255, 0, 255))
    image.save(sheet)

    from ymcp.tools.imagegen.v2f_core import FramesheetPlan, frameset_from_framesheet

    def fake_capture(plan):
        calls.append(plan)
        frame_set = frameset_from_framesheet(FramesheetPlan(sheet, "2x1"))
        frame_set.cache_key = plan.cache_key()
        return frame_set

    monkeypatch.setattr("ymcp.tools.imagegen.session.capture_video_frames", fake_capture)
    monkeypatch.setattr(
        "ymcp.tools.imagegen.local_frame_workflow.save_webp",
        lambda frames, out, **kwargs: frames[0].save(out, save_all=True, append_images=frames[1:], duration=80, loop=0),
    )
    store = V2FSessionStore(tmp_path / "sessions")
    server = ThreadingHTTPServer(("127.0.0.1", 0), create_v2f_app(store))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, payload = _request(server, "POST", "/api/sessions", {"kind": "video"})
        assert status == 200
        session_id = payload["id"]

        status, _ = _request(server, "POST", f"/api/sessions/{session_id}/capture", {"source": str(tmp_path / "clip.mp4"), "count": 2, "seconds": "0-1", "decode_size": "256"})
        assert status == 200
        status, _ = _request(server, "PATCH", f"/api/sessions/{session_id}/visual", {"remove_background": False, "fade": "100"})
        assert status == 200
        status, _ = _request(server, "PATCH", f"/api/sessions/{session_id}/timing", {"preset": "hold_then_burst"})
        assert status == 200
        status, _ = _request(server, "GET", f"/api/sessions/{session_id}/preview")
        assert status == 200

        assert len(calls) == 1
    finally:
        server.shutdown()
        server.server_close()
        store.close()

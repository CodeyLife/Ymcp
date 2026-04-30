from http.client import HTTPConnection
import base64
import json
import threading
from pathlib import Path

import pytest

Image = pytest.importorskip("PIL.Image")

from http.server import ThreadingHTTPServer

from ymcp.tools.imagegen.session import V2FSessionStore
from ymcp.web.v2f_app import create_v2f_app, run_v2f_editor


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

    status, payload = _request(
        v2f_server,
        "PATCH",
        f"/api/sessions/{session_id}/timing",
        {
            "duration_seconds": 8,
            "speed_keyframes": [
                {"time": 1, "before": 0.4, "after": 5},
                {"time": 5, "before": 2, "after": 1},
            ],
        },
    )
    assert status == 200
    assert payload["timing_spec"]["preset"] == "speed_keyframes"
    assert payload["timing_spec"]["points"][0] == {"output": 0.0, "source": 0.0}
    assert payload["timing_spec"]["points"][-1] == {"output": 1.0, "source": 1.0}

    status, payload = _request(v2f_server, "GET", f"/api/sessions/{session_id}/preview")
    assert status == 200
    assert payload["url"] == f"/api/sessions/{session_id}/artifact/preview"

    status, payload = _request(v2f_server, "GET", f"/api/sessions/{session_id}/cache")
    assert status == 200
    assert payload["cached_in_memory"] is True
    assert payload["frame_count"] == 2

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
    assert "updateGridFromCount" in html
    assert '<video id="videoPlayer" controls' in html
    assert 'id="videoPreview"' in html
    assert 'id="cropBox"' in html
    assert "视频裁剪" in html
    assert "裁剪坐标" in html
    assert "重置裁剪框" in html
    assert "右侧参数复用已取帧素材" in html
    assert "裁剪区域" not in html
    assert "输出日志" in html
    assert 'class="log-panel"' in html
    assert "处理中，请稍候" in html
    assert "正在创建会话并抽取视频帧" in html
    assert "正在生成预览" in html
    assert "button:disabled" in html
    assert "中心不透明半径（%）" in html
    assert "边缘衰减速度" in html
    assert "淡出预设" in html
    assert "透明淡出：中心 80% 保持不透明" in html
    assert "scheduleVisualPreview" not in html
    assert "节奏模板" in html
    assert "速度关键帧" in html
    assert "原视频时长（秒）" in html
    assert "添加关键帧" in html
    assert "恢复单关键帧预设" in html
    assert 'id="speedCurve"' in html
    assert "拖动圆点调整关键帧时间" in html
    assert "前速度" in html
    assert "后速度" in html
    assert "速度关键帧 JSON" in html
    assert '[{"time":1,"before":0.4,"after":5}]' in html
    assert "蓄力时长（%）" not in html
    assert "停顿强度（%）" not in html
    assert "爆发位置（%）" not in html
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
    assert payload["url"].startswith("/api/uploads/")

    conn = HTTPConnection(v2f_server.server_address[0], v2f_server.server_address[1], timeout=5)
    conn.request("GET", payload["url"])
    response = conn.getresponse()
    body = response.read()
    conn.close()
    assert response.status == 200
    assert body == b"fake-video"
    assert response.getheader("accept-ranges") == "bytes"

    conn = HTTPConnection(v2f_server.server_address[0], v2f_server.server_address[1], timeout=5)
    conn.request("GET", payload["url"], headers={"Range": "bytes=2-5"})
    response = conn.getresponse()
    body = response.read()
    conn.close()
    assert response.status == 206
    assert response.getheader("content-range") == "bytes 2-5/10"
    assert body == b"ke-v"


def test_run_v2f_editor_defaults_output_under_launch_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    server, url = run_v2f_editor(open_browser=False)
    try:
        assert server.v2f_output_root == tmp_path / "v2f-ui-output"
        status, payload = _request(
            server,
            "POST",
            "/api/uploads",
            {"filename": "clip.mp4", "data_base64": base64.b64encode(b"fake-video").decode("ascii")},
        )
        assert status == 200
        assert not Path(payload["path"]).is_relative_to(tmp_path / "v2f-ui-output")
        assert url.startswith("http://")
    finally:
        server.shutdown()
        server.server_close()


def test_run_v2f_editor_exports_under_launch_directory_but_keeps_uploads_temporary(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    sheet = tmp_path / "sheet.png"
    Image.new("RGBA", (10, 10), (255, 0, 0, 255)).save(sheet)
    server, _ = run_v2f_editor(open_browser=False)
    try:
        status, payload = _request(server, "POST", "/api/sessions", {"kind": "framesheet", "source": str(sheet), "grid": "1x1"})
        assert status == 200

        status, payload = _request(server, "POST", f"/api/sessions/{payload['id']}/export", {"format": "framesheet"})
        assert status == 200
        assert Path(payload["framesheet"]).is_relative_to(tmp_path / "v2f-ui-output")
    finally:
        server.shutdown()
        server.server_close()


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

        status, _ = _request(server, "POST", f"/api/sessions/{session_id}/capture", {"source": str(tmp_path / "clip.mp4"), "count": 2, "seconds": "0-1", "decode_size": "256", "crop": [0, 0, 10, 10]})
        assert status == 200
        status, _ = _request(server, "PATCH", f"/api/sessions/{session_id}/visual", {"remove_background": False, "fade": "100"})
        assert status == 200
        status, _ = _request(server, "PATCH", f"/api/sessions/{session_id}/timing", {"preset": "hold_then_burst"})
        assert status == 200
        status, _ = _request(server, "GET", f"/api/sessions/{session_id}/preview")
        assert status == 200

        assert len(calls) == 1
        assert calls[0].crop == (0, 0, 10, 10)
    finally:
        server.shutdown()
        server.server_close()
        store.close()


def test_v2f_web_app_video_crop_change_recaptures(tmp_path, monkeypatch):
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
    store = V2FSessionStore(tmp_path / "sessions")
    server = ThreadingHTTPServer(("127.0.0.1", 0), create_v2f_app(store))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, payload = _request(server, "POST", "/api/sessions", {"kind": "video"})
        assert status == 200
        session_id = payload["id"]

        body = {"source": str(tmp_path / "clip.mp4"), "count": 2, "seconds": "0-1", "decode_size": "256"}
        status, _ = _request(server, "POST", f"/api/sessions/{session_id}/capture", body | {"crop": [0, 0, 10, 10]})
        assert status == 200
        status, _ = _request(server, "POST", f"/api/sessions/{session_id}/capture", body | {"crop": [2, 0, 12, 10]})
        assert status == 200

        assert [call.crop for call in calls] == [(0, 0, 10, 10), (2, 0, 12, 10)]
    finally:
        server.shutdown()
        server.server_close()
        store.close()

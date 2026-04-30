from pathlib import Path

import pytest

Image = pytest.importorskip("PIL.Image")

from ymcp.tools.imagegen.session import V2FSessionStore, resolve_safe_path
from ymcp.tools.imagegen.v2f_core import CapturePlan, FramesheetPlan, VisualPipelineSpec, frameset_from_framesheet, render_frames


def _make_sheet(path: Path) -> None:
    image = Image.new("RGBA", (20, 10), (0, 0, 0, 0))
    for x in range(10):
        for y in range(10):
            image.putpixel((x, y), (255, 0, 0, 255))
            image.putpixel((x + 10, y), (0, 255, 0, 255))
    image.save(path)


def test_framesheet_plan_creates_first_class_frameset(tmp_path):
    sheet = tmp_path / "sheet.png"
    _make_sheet(sheet)

    frame_set = frameset_from_framesheet(FramesheetPlan(sheet, "2x1"))

    assert frame_set.source_kind == "framesheet"
    assert frame_set.frame_count == 2
    assert frame_set.framesheet_plan is not None


def test_render_frames_applies_visual_without_mutating_source(tmp_path):
    sheet = tmp_path / "sheet.png"
    _make_sheet(sheet)
    frame_set = frameset_from_framesheet(FramesheetPlan(sheet, "2x1"))

    rendered = render_frames(frame_set, VisualPipelineSpec(remove_background=False, output_size=(5, 5), fade="100"))

    assert len(rendered) == 2
    assert rendered[0].size == (5, 5)
    assert frame_set.frames[0].size == (10, 10)


def test_session_capture_reuses_same_capture_key(monkeypatch, tmp_path):
    calls = []
    store = V2FSessionStore(tmp_path / "sessions")
    session = store.create_empty()

    def fake_capture(plan):
        calls.append(plan)
        frame_set = frameset_from_framesheet(FramesheetPlan(sheet, "2x1"))
        frame_set.cache_key = plan.cache_key()
        return frame_set

    sheet = tmp_path / "sheet.png"
    _make_sheet(sheet)
    monkeypatch.setattr("ymcp.tools.imagegen.session.capture_video_frames", fake_capture)

    plan = CapturePlan(source=tmp_path / "clip.mp4", count=2, seconds="0-1", decode_size="256")
    store.capture_video(session.id, plan)
    store.capture_video(session.id, plan)

    assert len(calls) == 1


def test_session_reset_removes_temp_root(tmp_path):
    store = V2FSessionStore(tmp_path / "sessions")
    session = store.create_empty()
    marker = session.temp_root / "marker.txt"
    marker.write_text("x")

    store.reset(session.id)

    assert not session.temp_root.exists()


def test_resolve_safe_path_rejects_path_outside_base(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("x")

    with pytest.raises(ValueError):
        resolve_safe_path(outside, base=base)


def test_session_export_rejects_external_directory_by_default(tmp_path):
    sheet = tmp_path / "sheet.png"
    _make_sheet(sheet)
    store = V2FSessionStore(tmp_path / "sessions")
    session = store.create_from_framesheet(sheet, "2x1")

    with pytest.raises(ValueError):
        store.export(session.id, tmp_path / "outside")

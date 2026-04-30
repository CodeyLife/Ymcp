from pathlib import Path

import pytest

Image = pytest.importorskip("PIL.Image")

from ymcp.tools.imagegen.session import V2FSessionStore, resolve_safe_path
from ymcp.tools.imagegen.v2f_core import CapturePlan, FrameSet, FramesheetPlan, VisualPipelineSpec, frameset_from_framesheet, render_frames


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


def test_render_frames_radial_fade_changes_corner_alpha(tmp_path):
    image = Image.new("RGBA", (11, 11), (255, 0, 0, 255))
    frame_set = FrameSet([image], "framesheet", "test")

    unchanged = render_frames(frame_set, VisualPipelineSpec(remove_background=False, fade="100"))[0]
    faded = render_frames(frame_set, VisualPipelineSpec(remove_background=False, fade="80-1"))[0]

    assert unchanged.getpixel((0, 0))[3] == 255
    assert faded.getpixel((0, 0))[3] == 0
    assert faded.getpixel((5, 5))[3] == 255


def test_render_frames_parallel_matches_serial(tmp_path):
    frames = [
        Image.new("RGBA", (11, 11), (255, 0, 0, 255)),
        Image.new("RGBA", (11, 11), (0, 255, 0, 255)),
        Image.new("RGBA", (11, 11), (0, 0, 255, 255)),
    ]
    frame_set = FrameSet(frames, "framesheet", "test")
    visual = VisualPipelineSpec(remove_background=False, fade="50-2")

    serial = render_frames(frame_set, visual, max_workers=1)
    parallel = render_frames(frame_set, visual, max_workers=3)

    assert [list(image.getdata()) for image in parallel] == [list(image.getdata()) for image in serial]


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


def test_session_cache_summary_reports_in_memory_frames(tmp_path):
    sheet = tmp_path / "sheet.png"
    _make_sheet(sheet)
    store = V2FSessionStore(tmp_path / "sessions")
    session = store.create_from_framesheet(sheet, "2x1")

    summary = store.cache_summary(session.id)

    assert summary["cached_in_memory"] is True
    assert summary["frame_count"] == 2
    assert summary["source_kind"] == "framesheet"


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

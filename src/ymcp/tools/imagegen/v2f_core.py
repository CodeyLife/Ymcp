"""Reusable v2f capture, render, preview, and export primitives."""

from __future__ import annotations

from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import time
from typing import Any, Literal

from ymcp.tools.imagegen import local_frame_workflow as legacy
from ymcp.tools.imagegen.timing import TimingMapSpec, output_frame_source_indices


SourceKind = Literal["video", "framesheet"]
Color = tuple[int, int, int]


@dataclass(frozen=True)
class CapturePlan:
    """Video decode/sampling plan.

    ``decode_size`` belongs to capture. User-facing crop/output resize belongs
    to ``VisualPipelineSpec`` so those edits do not invalidate captured frames.
    """

    source: str | Path
    count: int
    seconds: str | None = None
    decode_size: str | int | None = None

    def cache_key(self) -> str:
        return _hash_payload(
            {
                "source": _source_identity(self.source),
                "count": self.count,
                "seconds": self.seconds,
                "decode_size": self.decode_size,
            }
        )


@dataclass(frozen=True)
class FramesheetPlan:
    source: str | Path
    grid: str | tuple[int, int]

    def cache_key(self) -> str:
        return _hash_payload({"source": _source_identity(self.source), "grid": self.grid})


@dataclass
class FrameSet:
    """Cached source frames from either video capture or framesheet import."""

    frames: list[object]
    source_kind: SourceKind
    cache_key: str
    source_metadata: dict[str, Any] = field(default_factory=dict)
    capture_plan: CapturePlan | None = None
    framesheet_plan: FramesheetPlan | None = None
    created_at: float = field(default_factory=time.time)

    @property
    def frame_count(self) -> int:
        return len(self.frames)


@dataclass(frozen=True)
class VisualPipelineSpec:
    remove_background: bool = True
    background_tolerance: int = 12
    key_color: Color | None = None
    crop: tuple[int, int, int, int] | None = None
    output_size: tuple[int, int] | None = None
    fade: str | legacy.RadialFadeSpec | None = "default"

    def __post_init__(self) -> None:
        if not (0 <= self.background_tolerance <= 255):
            raise ValueError("background_tolerance must be between 0 and 255")
        if self.crop is not None:
            left, upper, right, lower = self.crop
            if right <= left or lower <= upper:
                raise ValueError("crop must be (left, upper, right, lower) with positive area")
        if self.output_size is not None and (self.output_size[0] < 1 or self.output_size[1] < 1):
            raise ValueError("output_size dimensions must be positive")


@dataclass(frozen=True)
class ExportSpec:
    columns: int | None = None
    duration_ms: int = 80
    loop: int = 0
    lossless: bool = True

    def __post_init__(self) -> None:
        if self.columns is not None and self.columns < 1:
            raise ValueError("columns must be at least 1")
        if self.duration_ms <= 0:
            raise ValueError("duration_ms must be positive")


@dataclass(frozen=True)
class PreviewSpec:
    max_frames: int = 12
    max_size: int = 256
    animated: bool = True

    def __post_init__(self) -> None:
        if self.max_frames < 1:
            raise ValueError("max_frames must be at least 1")
        if self.max_size < 1:
            raise ValueError("max_size must be positive")


def _hash_payload(payload: dict[str, Any]) -> str:
    serialized = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return sha256(serialized.encode("utf-8")).hexdigest()[:16]


def _source_identity(source: str | Path) -> dict[str, Any]:
    raw = str(source)
    path = Path(raw)
    if path.exists():
        stat = path.stat()
        return {"path": str(path.resolve()), "mtime_ns": stat.st_mtime_ns, "size": stat.st_size}
    return {"source": raw}


def capture_video_frames(plan: CapturePlan) -> FrameSet:
    """Decode/sample video frames without visual post-processing or export."""

    if plan.count < 1:
        raise ValueError("frame count must be at least 1")
    target_size = legacy.parse_video_frame_size(plan.decode_size)
    video_duration = legacy._probe_video_duration(plan.source)
    range_seconds = legacy.parse_video_seconds(plan.seconds) or (0.0, video_duration)
    start, end = range_seconds
    if start >= video_duration:
        raise ValueError(f"video segment starts after video duration ({video_duration:.3f}s)")
    end = min(end, video_duration)
    times = legacy.video_sample_times(plan.count, start, end)

    Image, _ = legacy._load_pillow()
    frames: list[object] = []
    for timestamp in times:
        with Image.open(BytesIO(legacy._extract_video_frame_png(plan.source, timestamp, min_timestamp=start))) as image:
            frame = image.convert("RGBA") if image.mode in {"RGBA", "LA", "P"} or "transparency" in image.info else image.convert("RGB")
            if target_size is not None:
                frame = frame.resize(target_size, Image.Resampling.LANCZOS)
            frames.append(frame.copy())
    return FrameSet(
        frames=frames,
        source_kind="video",
        cache_key=plan.cache_key(),
        capture_plan=plan,
        source_metadata={"duration": video_duration, "seconds": [start, end], "sample_times": times},
    )


def frameset_from_framesheet(plan: FramesheetPlan) -> FrameSet:
    frames = legacy._frames_from_sheet(plan.source, plan.grid)
    return FrameSet(
        frames=[frame.copy() for frame in frames],
        source_kind="framesheet",
        cache_key=plan.cache_key(),
        framesheet_plan=plan,
        source_metadata={"grid": plan.grid},
    )


def render_frames(
    frame_set: FrameSet,
    visual: VisualPipelineSpec | None = None,
    timing: TimingMapSpec | None = None,
    *,
    output_count: int | None = None,
    max_workers: int | None = None,
) -> list[object]:
    """Apply visual processing and deterministic timing remap to a FrameSet."""

    active_visual = visual or VisualPipelineSpec(remove_background=False)
    source_frames = frame_set.frames
    count = output_count or len(source_frames)
    indices = output_frame_source_indices(count, len(source_frames), timing)
    fade_spec = legacy.parse_radial_fade(active_visual.fade)
    if active_visual.remove_background and active_visual.key_color is None:
        background_key: Color | None = legacy.dominant_image_color(source_frames[indices[0]])
    else:
        background_key = active_visual.key_color

    def render_one(index: int) -> object:
        Image, _ = legacy._load_pillow()
        frame = source_frames[index].copy()
        if active_visual.crop is not None:
            frame = frame.crop(active_visual.crop)
        if active_visual.remove_background:
            frame = frame.convert("RGBA")
            legacy._apply_alpha_to_image(
                frame,
                key=background_key or legacy.dominant_image_color(frame),
                tolerance=active_visual.background_tolerance,
                spill_cleanup=True,
                soft_matte=True,
                transparent_threshold=float(active_visual.background_tolerance),
                opaque_threshold=220.0,
            )
        frame = legacy._apply_radial_alpha_fade(frame, fade_spec)
        if active_visual.output_size is not None:
            frame = frame.resize(active_visual.output_size, Image.Resampling.LANCZOS)
        return frame.copy()

    worker_count = max_workers if max_workers is not None else min(8, max(1, len(indices)))
    if worker_count <= 1 or len(indices) <= 1:
        return [render_one(index) for index in indices]
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        return list(executor.map(render_one, indices))


def preview_frames(
    frame_set: FrameSet,
    visual: VisualPipelineSpec | None = None,
    timing: TimingMapSpec | None = None,
    preview: PreviewSpec | None = None,
) -> list[object]:
    active_preview = preview or PreviewSpec()
    output_count = min(active_preview.max_frames, frame_set.frame_count)
    frames = render_frames(frame_set, visual, timing, output_count=output_count)
    Image, _ = legacy._load_pillow()
    resized = []
    for frame in frames:
        if max(frame.size) > active_preview.max_size:
            ratio = active_preview.max_size / float(max(frame.size))
            size = (max(1, round(frame.width * ratio)), max(1, round(frame.height * ratio)))
            frame = frame.resize(size, Image.Resampling.LANCZOS)
        resized.append(frame)
    return resized


def export_framesheet_webp(frames: list[object], out_dir: str | Path, spec: ExportSpec | None = None) -> Path:
    active = spec or ExportSpec()
    if not frames:
        raise ValueError("at least one rendered frame is required")
    root = Path(out_dir)
    root.mkdir(parents=True, exist_ok=True)
    columns = active.columns or legacy.near_square_columns(len(frames))
    legacy.save_sprite_sheet(frames, root / "framesheet.png", columns=columns)
    legacy._save_webp_animation_with_ffmpeg(
        frames,
        root / "animation.webp",
        duration_ms=active.duration_ms,
        loop=active.loop,
        lossless=active.lossless,
    )
    return root


__all__ = [
    "CapturePlan",
    "ExportSpec",
    "FrameSet",
    "FramesheetPlan",
    "PreviewSpec",
    "VisualPipelineSpec",
    "capture_video_frames",
    "export_framesheet_webp",
    "frameset_from_framesheet",
    "preview_frames",
    "render_frames",
]

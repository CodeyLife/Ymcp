"""Local Pillow helpers for deterministic imagegen frame workflows.

The module intentionally performs no network calls and has no dependency on hosted
image-generation SDKs. Pillow is imported lazily so Ymcp can keep it as an
optional dependency for users who opt into local image generation.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import json
from io import BytesIO
from pathlib import Path
import re
import shutil
import math
from statistics import median
import subprocess
import tempfile
from typing import Any, Iterable, Tuple
from urllib.parse import urlparse

Color = Tuple[int, int, int]
KEY_DOMINANCE_THRESHOLD = 16.0
ALPHA_NOISE_FLOOR = 8
DEFAULT_RADIAL_FADE_OPAQUE_PERCENT = 80.0
DEFAULT_RADIAL_FADE_SPEED = 1.0


@dataclass(frozen=True)
class RadialFadeSpec:
    """Radial alpha-fade settings for v2f output frames."""

    opaque_percent: float = DEFAULT_RADIAL_FADE_OPAQUE_PERCENT
    speed: float = DEFAULT_RADIAL_FADE_SPEED


def _load_pillow():
    try:
        from PIL import Image, ImageFilter
    except ImportError as exc:  # pragma: no cover - exercised only without optional dependency
        raise RuntimeError(
            "Pillow is required for local imagegen workflows. Install with `pip install ymcp[imagegen]`."
        ) from exc
    return Image, ImageFilter


def ensure_output_dirs(root: str | Path, frames_name: str = "frames") -> tuple[Path, Path]:
    """Create and return the workflow root and frame directory."""

    root_path = Path(root)
    frames_dir = root_path / frames_name
    frames_dir.mkdir(parents=True, exist_ok=True)
    return root_path, frames_dir


def frame_path(frames_dir: str | Path, index: int, *, prefix: str = "frame", ext: str = "png", digits: int = 4) -> Path:
    """Return a stable sequence-frame path such as ``frame_0007.png``."""

    if index < 0:
        raise ValueError("index must be non-negative")
    clean_ext = ext.lower().lstrip(".")
    if clean_ext not in {"png", "webp", "jpg", "jpeg"}:
        raise ValueError("ext must be png, webp, jpg, or jpeg")
    return Path(frames_dir) / f"{prefix}_{index:0{digits}d}.{clean_ext}"


def _as_image_sequence(frames: Iterable[object]) -> list[object]:
    images = list(frames)
    if not images:
        raise ValueError("at least one frame is required")
    return images


def save_sprite_sheet(frames: Iterable[object], out: str | Path, *, columns: int, padding: int = 0, background: Color | tuple[int, int, int, int] = (0, 0, 0, 0)) -> Path:
    """Save frames into a sprite sheet and return the output path."""

    Image, _ = _load_pillow()
    images = _as_image_sequence(frames)
    if columns < 1:
        raise ValueError("columns must be at least 1")
    if padding < 0:
        raise ValueError("padding must be non-negative")

    width, height = images[0].size
    for image in images:
        if image.size != (width, height):
            raise ValueError("all frames must have the same dimensions")

    rows = (len(images) + columns - 1) // columns
    sheet_width = columns * width + max(0, columns - 1) * padding
    sheet_height = rows * height + max(0, rows - 1) * padding
    mode = "RGBA" if len(background) == 4 else "RGB"
    sheet = Image.new(mode, (sheet_width, sheet_height), background)

    for idx, image in enumerate(images):
        x = (idx % columns) * (width + padding)
        y = (idx // columns) * (height + padding)
        if image.mode == "RGBA":
            if sheet.mode == "RGBA":
                sheet.paste(image, (x, y))
            else:
                sheet.paste(image, (x, y), image)
        else:
            sheet.paste(image, (x, y))

    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path)
    return out_path


def save_gif(frames: Iterable[object], out: str | Path, *, duration_ms: int = 100, loop: int = 0, disposal: int = 2) -> Path:
    """Save frames as an animated GIF.

    The default ``disposal=2`` restores the canvas to the background before the
    next frame. This avoids the common transparent-GIF failure mode where every
    frame accumulates on top of the previous one.
    """

    images = _as_image_sequence(frames)
    if duration_ms <= 0:
        raise ValueError("duration_ms must be positive")
    if disposal not in {0, 1, 2, 3}:
        raise ValueError("disposal must be one of 0, 1, 2, or 3")
    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    images[0].save(
        out_path,
        save_all=True,
        append_images=images[1:],
        duration=duration_ms,
        loop=loop,
        disposal=disposal,
    )
    return out_path


def save_webp(frames: Iterable[object], out: str | Path, *, duration_ms: int = 100, loop: int = 0, lossless: bool = True) -> Path:
    """Save frames as an animated WebP."""

    images = _as_image_sequence(frames)
    if duration_ms <= 0:
        raise ValueError("duration_ms must be positive")
    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    images[0].save(out_path, save_all=True, append_images=images[1:], duration=duration_ms, loop=loop, lossless=lossless)
    return out_path




def parse_grid(raw: str) -> tuple[int, int]:
    """Parse a COLSxROWS grid string such as ``4x4``."""

    match = re.fullmatch(r"([1-9][0-9]*)[xX]([1-9][0-9]*)", raw.strip())
    if not match:
        raise ValueError("grid must be COLSxROWS, for example 4x4")
    return int(match.group(1)), int(match.group(2))


def parse_video_seconds(raw: str | None) -> tuple[float, float] | None:
    """Parse a video time range.

    ``None`` means the caller should use the whole video. ``"2"`` means
    0..2 seconds and ``"1-2"`` means 1..2 seconds.
    """

    if raw is None:
        return None
    value = raw.strip()
    if not value:
        raise ValueError("seconds must not be empty")
    if "-" in value:
        left, right = value.split("-", 1)
        if not left.strip() or not right.strip():
            raise ValueError("seconds range must be START-END, for example 1-2")
        start = float(left)
        end = float(right)
    else:
        start = 0.0
        end = float(value)
    if start < 0 or end <= start:
        raise ValueError("seconds must describe a positive range")
    return start, end


def parse_video_frame_size(raw: str | int | None) -> tuple[int, int] | None:
    """Parse a video frame size.

    ``None`` defaults to 256x256, ``"full"`` preserves source dimensions,
    ``"512"`` means 512x512, and ``"320x180"`` means an explicit rectangle.
    """

    if raw is None:
        return (256, 256)
    if isinstance(raw, int):
        if raw < 1:
            raise ValueError("size must be positive")
        return (raw, raw)
    value = raw.strip().lower()
    if value == "full":
        return None
    if re.fullmatch(r"[1-9][0-9]*", value):
        size = int(value)
        return (size, size)
    match = re.fullmatch(r"([1-9][0-9]*)[xX]([1-9][0-9]*)", value)
    if match:
        return int(match.group(1)), int(match.group(2))
    raise ValueError("size must be full, a positive integer, or WIDTHxHEIGHT")


def parse_radial_fade(raw: str | RadialFadeSpec | None = None) -> RadialFadeSpec:
    """Parse a v2f radial fade value.

    ``None`` and ``"default"`` mean an 80% fully opaque radius with linear
    falloff. Numeric values set the opaque-radius percentage, and
    ``PERCENT-SPEED`` additionally sets the falloff curve speed.
    """

    if isinstance(raw, RadialFadeSpec):
        return raw
    if raw is None:
        return RadialFadeSpec()

    value = raw.strip()
    if value.lower() == "default":
        return RadialFadeSpec()
    if not value:
        raise ValueError("fade must be default, PERCENT, or PERCENT-SPEED")

    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?|[0-9]*\.[0-9]+)%?(?:-([0-9]+(?:\.[0-9]+)?|[0-9]*\.[0-9]+))?", value)
    if not match:
        raise ValueError("fade must be default, PERCENT, or PERCENT-SPEED")

    opaque_percent = float(match.group(1))
    speed = float(match.group(2)) if match.group(2) is not None else DEFAULT_RADIAL_FADE_SPEED
    if not (0.0 <= opaque_percent <= 100.0):
        raise ValueError("fade percent must be between 0 and 100")
    if speed <= 0.0:
        raise ValueError("fade speed must be positive")
    return RadialFadeSpec(opaque_percent=opaque_percent, speed=speed)


def video_sample_times(count: int, start: float, end: float) -> list[float]:
    """Return evenly distributed in-segment sample timestamps.

    Samples use bin centers instead of the exact segment end. Many video
    containers report duration as the timestamp just after the final decodable
    frame, so seeking to ``end`` can legitimately return no frame.
    """

    if count < 1:
        raise ValueError("frame count must be at least 1")
    if start < 0 or end <= start:
        raise ValueError("video segment must have a positive duration")
    step = (end - start) / float(count)
    return [start + (step * (index + 0.5)) for index in range(count)]


def dominant_image_color(image) -> Color:
    """Return the most common RGB color in an image."""

    rgb = image.convert("RGB")
    colors = rgb.getcolors(maxcolors=rgb.width * rgb.height)
    if colors is not None:
        return max(colors, key=lambda item: item[0])[1]
    else:
        counter = Counter(rgb.getdata())
        return counter.most_common(1)[0][0]


def near_square_columns(frame_count: int) -> int:
    """Choose a compact framesheet column count.

    Preference is given to a divisor at or below the square root so exact grids
    like 24 -> 4x6 and 20 -> 4x5 stay compact instead of becoming one long row.
    """

    if frame_count < 1:
        raise ValueError("frame_count must be at least 1")
    root = int(math.sqrt(frame_count))
    for columns in range(root, 0, -1):
        if frame_count % columns == 0:
            return columns
    return root or 1


def _is_url(raw: str) -> bool:
    parsed = urlparse(raw)
    return parsed.scheme in {"http", "https", "ftp", "s3"}


def _default_video_frames_dir(video: str | Path) -> Path:
    return Path.cwd() / "video_frames"


def _require_executable(name: str) -> str:
    executable = shutil.which(name)
    if executable is None:
        raise RuntimeError(f"{name} is required for video frame extraction and was not found in PATH")
    return executable


def _positive_float(raw: object) -> float | None:
    if raw in {None, "", "N/A"}:
        return None
    try:
        value = float(str(raw))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _rate_to_float(raw: object) -> float | None:
    if raw in {None, "", "0/0", "N/A"}:
        return None
    text = str(raw)
    if "/" in text:
        numerator, denominator = text.split("/", 1)
        try:
            den = float(denominator)
            if den == 0:
                return None
            value = float(numerator) / den
        except ValueError:
            return None
    else:
        try:
            value = float(text)
        except ValueError:
            return None
    return value if value > 0 else None


def _probe_video_duration(video: str | Path) -> float:
    ffprobe = _require_executable("ffprobe")
    completed = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "format=duration:stream=duration,nb_frames,r_frame_rate,avg_frame_rate",
            "-of",
            "json",
            str(video),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "unknown ffprobe error"
        raise RuntimeError(f"ffprobe failed: {detail}")

    durations: list[float] = []
    try:
        data = json.loads(completed.stdout)
    except (TypeError, ValueError, UnicodeDecodeError):
        # Backward-compatible fallback for older tests or non-JSON ffprobe wrappers.
        duration = _positive_float(completed.stdout.strip())
        if duration is None:
            raise RuntimeError("ffprobe did not return a valid video duration")
        return duration
    if not isinstance(data, dict):
        duration = _positive_float(data)
        if duration is None:
            raise RuntimeError("ffprobe did not return a valid video duration")
        return duration

    format_duration = _positive_float(data.get("format", {}).get("duration"))
    if format_duration is not None:
        durations.append(format_duration)

    streams = data.get("streams") or []
    if streams:
        stream = streams[0]
        stream_duration = _positive_float(stream.get("duration"))
        if stream_duration is not None:
            durations.append(stream_duration)
        frame_count = _positive_float(stream.get("nb_frames"))
        frame_rate = _rate_to_float(stream.get("avg_frame_rate")) or _rate_to_float(stream.get("r_frame_rate"))
        if frame_count is not None and frame_rate is not None:
            durations.append(frame_count / frame_rate)

    if not durations:
        raise RuntimeError("ffprobe did not return a valid video duration")

    # Use the conservative positive duration. Some containers report the format
    # duration as the timestamp just after the last frame (or even slightly past
    # it), which can make the final sampled timestamp undecodable.
    duration = min(durations)
    if duration <= 0:
        raise ValueError("video duration must be positive")
    return duration


def _extract_video_frame_png(video: str | Path, timestamp: float, *, min_timestamp: float = 0.0) -> bytes:
    ffmpeg = _require_executable("ffmpeg")
    attempts = [max(min_timestamp, timestamp)]
    # If a container overstates the last decodable timestamp, retry just before
    # the requested point instead of failing the whole extraction. This keeps
    # user-facing sampling inside the requested segment/video length.
    for delta in (0.05, 0.10, 0.25, 0.50, 1.00):
        candidate = max(min_timestamp, timestamp - delta)
        if all(abs(candidate - previous) > 1e-6 for previous in attempts):
            attempts.append(candidate)

    last_detail = "no frame data returned"
    for attempt in attempts:
        completed = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                f"{attempt:.6f}",
                "-i",
                str(video),
                "-frames:v",
                "1",
                "-f",
                "image2pipe",
                "-vcodec",
                "png",
                "pipe:1",
            ],
            check=False,
            capture_output=True,
        )
        if completed.returncode == 0 and completed.stdout:
            return completed.stdout
        last_detail = completed.stderr.decode("utf-8", errors="replace").strip() or "no frame data returned"

    raise RuntimeError(f"ffmpeg failed at {timestamp:.3f}s: {last_detail}")


def _save_webp_animation_with_ffmpeg(
    frames: Iterable[object],
    out: str | Path,
    *,
    duration_ms: int,
    loop: int = 0,
    lossless: bool = True,
) -> Path:
    """Save frames as animated WebP via ffmpeg.

    Pillow can write animated WebP, but some viewers accumulate transparent
    frames from those files. ffmpeg/libwebp_anim emits WebP animations that
    clear the previous frame correctly while keeping temporary PNGs ephemeral.
    """

    if duration_ms <= 0:
        raise ValueError("duration_ms must be positive")
    ffmpeg = _require_executable("ffmpeg")
    images = _as_image_sequence(frames)
    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    framerate = f"1000/{duration_ms}"
    with tempfile.TemporaryDirectory(prefix="ymcp-video-frames-") as temp_dir:
        temp_root = Path(temp_dir)
        for index, image in enumerate(images):
            image.save(temp_root / f"frame_{index:04d}.png", format="PNG")
        completed = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-framerate",
                framerate,
                "-i",
                str(temp_root / "frame_%04d.png"),
                "-loop",
                str(loop),
                "-lossless",
                "1" if lossless else "0",
                "-c:v",
                "libwebp_anim",
                str(out_path),
            ],
            check=False,
            capture_output=True,
        )
    if completed.returncode != 0 or not out_path.exists():
        detail = completed.stderr.decode("utf-8", errors="replace").strip() or "animated WebP was not created"
        raise RuntimeError(f"ffmpeg WebP encode failed: {detail}")
    _force_webp_replace_dispose(out_path)
    return out_path


def _force_webp_replace_dispose(path: str | Path) -> None:
    """Force animated WebP frames to replace and clear, not alpha-blend.

    The ANMF flags byte uses bit 0 for blending and bit 1 for disposal. Setting
    every frame to ``0b10`` means "do not blend with previous frame" and
    "dispose to background". This is intentionally defensive: different WebP
    encoders/viewers can otherwise make transparent animation frames appear to
    accumulate.
    """

    webp_path = Path(path)
    data = bytearray(webp_path.read_bytes())
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError(f"not a WebP file: {webp_path}")
    offset = 12
    changed = False
    while offset + 8 <= len(data):
        chunk_type = bytes(data[offset : offset + 4])
        chunk_size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        payload_offset = offset + 8
        if chunk_type == b"ANMF" and payload_offset + 16 <= len(data):
            data[payload_offset + 15] = 0b10
            changed = True
        offset = payload_offset + chunk_size + (chunk_size % 2)
    if changed:
        webp_path.write_bytes(data)


def extract_video_frames(
    video: str | Path,
    count: int,
    out: str | Path | None = None,
    *,
    seconds: str | None = None,
    size: str | int | None = None,
    overwrite: bool = True,
    remove_background: bool = True,
    background_tolerance: int = 12,
    columns: int | None = None,
    duration_ms: int | None = None,
    loop: int = 0,
    lossless: bool = True,
    fade: str | RadialFadeSpec | None = "default",
) -> Path:
    """Evenly extract video frames into a framesheet PNG and animated WebP.

    ffmpeg/ffprobe decode the video stream and Pillow performs deterministic
    resizing/saving. ``size='full'`` preserves the decoded frame dimensions.
    When ``remove_background`` is true, the most common RGB color in the first
    output frame is used as the background key for every saved frame. Individual
    sampled PNG frames are not written to disk.
    """

    if count < 1:
        raise ValueError("frame count must be at least 1")
    if not (0 <= background_tolerance <= 255):
        raise ValueError("background_tolerance must be between 0 and 255")
    if columns is not None and columns < 1:
        raise ValueError("columns must be at least 1")
    if duration_ms is not None and duration_ms <= 0:
        raise ValueError("duration_ms must be positive")
    out_dir = Path(out) if out is not None else _default_video_frames_dir(video)
    sheet_path = out_dir / "framesheet.png"
    webp_path = out_dir / "animation.webp"
    if out_dir.exists() and not overwrite:
        existing = [path for path in (sheet_path, webp_path) if path.exists()]
        if existing:
            raise FileExistsError(f"output already exists: {existing[0]}")
    out_dir.mkdir(parents=True, exist_ok=True)

    from ymcp.tools.imagegen.v2f_core import CapturePlan, ExportSpec, VisualPipelineSpec, capture_video_frames, export_framesheet_webp, render_frames

    frame_set = capture_video_frames(CapturePlan(video, count, seconds=seconds, decode_size=size))
    frames = render_frames(
        frame_set,
        VisualPipelineSpec(
            remove_background=remove_background,
            background_tolerance=background_tolerance,
            fade=fade,
        ),
    )
    start, end = frame_set.source_metadata.get("seconds", [0.0, float(count)])
    output_columns = columns if columns is not None else near_square_columns(count)
    output_duration = duration_ms if duration_ms is not None else max(1, int(round((end - start) * 1000.0 / count)))
    return export_framesheet_webp(frames, out_dir, ExportSpec(columns=output_columns, duration_ms=output_duration, loop=loop, lossless=lossless))



def _frames_from_sheet(image_path: str | Path, grid: str | tuple[int, int], *, frame_size: int | None = None) -> list[object]:
    if frame_size is not None and frame_size < 1:
        raise ValueError("frame_size must be positive")
    cols, rows = parse_grid(grid) if isinstance(grid, str) else grid
    if cols < 1 or rows < 1:
        raise ValueError("grid columns and rows must be positive")
    src = Path(image_path)
    if not src.exists():
        raise FileNotFoundError(f"input image not found: {src}")

    Image, _ = _load_pillow()
    with Image.open(src) as image:
        source = image.convert("RGBA") if image.mode in {"RGBA", "LA", "P"} or "transparency" in image.info else image.convert("RGB")

    cell_w = source.width / cols
    cell_h = source.height / rows
    frames: list[object] = []
    for row in range(rows):
        for col in range(cols):
            left = round(col * cell_w)
            upper = round(row * cell_h)
            right = round((col + 1) * cell_w)
            lower = round((row + 1) * cell_h)
            frame = source.crop((left, upper, right, lower))
            if frame_size is not None:
                frame = frame.resize((frame_size, frame_size), Image.Resampling.LANCZOS)
            frames.append(frame)
    return frames


def framesheet_to_gif(
    image_path: str | Path,
    grid: str | tuple[int, int],
    out: str | Path | None = None,
    *,
    duration_ms: int = 80,
    loop: int = 0,
    frame_size: int | None = None,
    overwrite: bool = True,
) -> Path:
    """Convert a framesheet into an animated GIF without writing individual frames."""

    src = Path(image_path)
    out_path = Path(out) if out is not None else src.with_suffix(".gif")
    if out_path.exists() and not overwrite:
        raise FileExistsError(f"output already exists: {out_path}")
    frames = _frames_from_sheet(src, grid, frame_size=frame_size)
    return save_gif(frames, out_path, duration_ms=duration_ms, loop=loop, disposal=2)


def framesheet_to_webp(
    image_path: str | Path,
    grid: str | tuple[int, int],
    out: str | Path | None = None,
    *,
    duration_ms: int = 80,
    loop: int = 0,
    frame_size: int | None = None,
    overwrite: bool = True,
    lossless: bool = True,
) -> Path:
    """Convert a framesheet into an animated WebP without writing individual frames."""

    src = Path(image_path)
    out_path = Path(out) if out is not None else src.with_suffix(".webp")
    if out_path.exists() and not overwrite:
        raise FileExistsError(f"output already exists: {out_path}")
    frames = _frames_from_sheet(src, grid, frame_size=frame_size)
    return save_webp(frames, out_path, duration_ms=duration_ms, loop=loop, lossless=lossless)


def resize_framesheet(
    image_path: str | Path,
    grid: str | tuple[int, int],
    out: str | Path | None = None,
    *,
    frame_size: int = 256,
    overwrite: bool = False,
) -> Path:
    """Resize a framesheet so every grid cell becomes ``frame_size`` square.

    ``grid`` is interpreted as columns x rows. The output is always written as
    PNG and preserves alpha when the source has transparency.
    """

    if frame_size < 1:
        raise ValueError("frame_size must be positive")
    cols, rows = parse_grid(grid) if isinstance(grid, str) else grid
    if cols < 1 or rows < 1:
        raise ValueError("grid columns and rows must be positive")

    src = Path(image_path)
    if not src.exists():
        raise FileNotFoundError(f"input image not found: {src}")
    out_path = Path(out) if out is not None else src.with_name(f"{src.stem}-{frame_size}{src.suffix if src.suffix.lower() == '.png' else '.png'}")
    if out_path.exists() and not overwrite:
        raise FileExistsError(f"output already exists: {out_path}")

    Image, _ = _load_pillow()
    with Image.open(src) as image:
        source = image.convert("RGBA") if image.mode in {"RGBA", "LA", "P"} or "transparency" in image.info else image.convert("RGB")

    cell_w = source.width / cols
    cell_h = source.height / rows
    mode = "RGBA" if source.mode == "RGBA" else "RGB"
    output = Image.new(mode, (cols * frame_size, rows * frame_size), (0, 0, 0, 0) if mode == "RGBA" else (0, 0, 0))

    for row in range(rows):
        for col in range(cols):
            left = round(col * cell_w)
            upper = round(row * cell_h)
            right = round((col + 1) * cell_w)
            lower = round((row + 1) * cell_h)
            frame = source.crop((left, upper, right, lower)).resize((frame_size, frame_size), Image.Resampling.LANCZOS)
            output.paste(frame, (col * frame_size, row * frame_size), frame if frame.mode == "RGBA" else None)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    output.save(out_path, format="PNG")
    return out_path

def validate_frame_sequence(
    frames_dir: str | Path,
    *,
    expected_count: int,
    expected_size: tuple[int, int],
    require_transparency: bool = False,
    sprite_path: str | Path | None = None,
    sprite_columns: int | None = None,
) -> dict[str, Any]:
    """Validate generated image sequence artifacts.

    Returns a structured report and raises ValueError on the first failing
    invariant. The checks are intentionally simple so generated scripts can call
    this helper before claiming completion.
    """

    if expected_count < 1:
        raise ValueError("expected_count must be at least 1")
    if expected_size[0] < 1 or expected_size[1] < 1:
        raise ValueError("expected_size dimensions must be positive")

    Image, _ = _load_pillow()
    frame_root = Path(frames_dir)
    frame_paths = sorted(frame_root.glob("frame_*.png"))
    if len(frame_paths) != expected_count:
        raise ValueError(f"expected {expected_count} frame_*.png files in {frame_root}, found {len(frame_paths)}")

    alpha_extrema: list[tuple[int, int]] = []
    for path in frame_paths:
        with Image.open(path) as image:
            if image.size != expected_size:
                raise ValueError(f"{path} has size {image.size}, expected {expected_size}")
            if require_transparency:
                if image.mode != "RGBA":
                    raise ValueError(f"{path} must be RGBA when transparency is required, got {image.mode}")
                extrema = image.getchannel("A").getextrema()
                alpha_extrema.append(extrema)
                if extrema[0] != 0:
                    raise ValueError(f"{path} does not contain fully transparent pixels; alpha extrema={extrema}")

    report: dict[str, Any] = {
        "frames_dir": str(frame_root),
        "frame_count": len(frame_paths),
        "frame_size": list(expected_size),
        "require_transparency": require_transparency,
        "alpha_extrema": [list(item) for item in alpha_extrema],
    }

    if sprite_path is not None:
        sprite = Path(sprite_path)
        if not sprite.exists():
            raise ValueError(f"sprite_path not found: {sprite}")
        with Image.open(sprite) as image:
            if sprite_columns is None or sprite_columns < 1:
                raise ValueError("sprite_columns must be provided and positive when sprite_path is set")
            rows = (expected_count + sprite_columns - 1) // sprite_columns
            expected_sprite_size = (expected_size[0] * sprite_columns, expected_size[1] * rows)
            if image.size != expected_sprite_size:
                raise ValueError(f"{sprite} has size {image.size}, expected {expected_sprite_size}")
            if require_transparency:
                if image.mode != "RGBA":
                    raise ValueError(f"{sprite} must be RGBA when transparency is required, got {image.mode}")
                extrema = image.getchannel("A").getextrema()
                if extrema[0] != 0:
                    raise ValueError(f"{sprite} does not contain fully transparent pixels; alpha extrema={extrema}")
            report["sprite_path"] = str(sprite)
            report["sprite_size"] = list(image.size)

    return report

def parse_key_color(raw: str) -> Color:
    value = raw.strip()
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", value)
    if not match:
        raise ValueError("key color must be a hex RGB value like #00ff00")
    hex_value = match.group(1)
    return (int(hex_value[0:2], 16), int(hex_value[2:4], 16), int(hex_value[4:6], 16))


def _channel_distance(a: Color, b: Color) -> int:
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2]))


def _clamp_channel(value: float) -> int:
    return max(0, min(255, int(round(value))))


def _clamp_unit(value: float) -> float:
    return max(0.0, min(1.0, value))


def _smoothstep(value: float) -> float:
    value = _clamp_unit(value)
    return value * value * (3.0 - 2.0 * value)


def _soft_alpha(distance: int, transparent_threshold: float, opaque_threshold: float) -> int:
    if distance <= transparent_threshold:
        return 0
    if distance >= opaque_threshold:
        return 255
    ratio = (float(distance) - transparent_threshold) / (opaque_threshold - transparent_threshold)
    return _clamp_channel(255.0 * _smoothstep(ratio))


def _spill_channels(key: Color) -> list[int]:
    key_max = max(key)
    if key_max < 128:
        return []
    return [idx for idx, value in enumerate(key) if value >= key_max - 16 and value >= 128]


def _key_channel_dominance(rgb: Color, key: Color) -> float:
    spill_channels = _spill_channels(key)
    if not spill_channels:
        return 0.0
    channels = [float(value) for value in rgb]
    non_spill = [idx for idx in range(3) if idx not in spill_channels]
    key_strength = min(channels[idx] for idx in spill_channels) if len(spill_channels) > 1 else channels[spill_channels[0]]
    non_key_strength = max((channels[idx] for idx in non_spill), default=0.0)
    return key_strength - non_key_strength


def _dominance_alpha(rgb: Color, key: Color) -> int:
    spill_channels = _spill_channels(key)
    if not spill_channels:
        return 255
    channels = [float(value) for value in rgb]
    non_spill = [idx for idx in range(3) if idx not in spill_channels]
    key_strength = min(channels[idx] for idx in spill_channels) if len(spill_channels) > 1 else channels[spill_channels[0]]
    non_key_strength = max((channels[idx] for idx in non_spill), default=0.0)
    dominance = key_strength - non_key_strength
    if dominance <= 0:
        return 255
    denominator = max(1.0, float(max(key)) - non_key_strength)
    alpha = 1.0 - min(1.0, dominance / denominator)
    return _clamp_channel(alpha * 255.0)


def _looks_key_colored(rgb: Color, key: Color, distance: int) -> bool:
    if distance <= 32:
        return True
    spill_channels = _spill_channels(key)
    if not spill_channels:
        return True
    return _key_channel_dominance(rgb, key) >= KEY_DOMINANCE_THRESHOLD


def _cleanup_spill(rgb: Color, key: Color, alpha: int = 255) -> Color:
    if alpha >= 252:
        return rgb
    spill_channels = _spill_channels(key)
    if not spill_channels:
        return rgb
    channels = [float(value) for value in rgb]
    non_spill = [idx for idx in range(3) if idx not in spill_channels]
    if non_spill:
        anchor = max(channels[idx] for idx in non_spill)
        cap = max(0.0, anchor - 1.0)
        for idx in spill_channels:
            if channels[idx] > cap:
                channels[idx] = cap
    return (_clamp_channel(channels[0]), _clamp_channel(channels[1]), _clamp_channel(channels[2]))


def _apply_alpha_to_image(image, *, key: Color, tolerance: int, spill_cleanup: bool, soft_matte: bool, transparent_threshold: float, opaque_threshold: float) -> int:
    pixels = image.load()
    width, height = image.size
    transparent = 0
    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            rgb = (red, green, blue)
            distance = _channel_distance(rgb, key)
            key_like = _looks_key_colored(rgb, key, distance)
            output_alpha = min(_soft_alpha(distance, transparent_threshold, opaque_threshold), _dominance_alpha(rgb, key)) if soft_matte and key_like else (0 if distance <= tolerance else 255)
            output_alpha = int(round(output_alpha * (alpha / 255.0)))
            if 0 < output_alpha <= ALPHA_NOISE_FLOOR:
                output_alpha = 0
            if output_alpha == 0:
                transparent += 1
            if spill_cleanup and key_like:
                red, green, blue = _cleanup_spill(rgb, key, output_alpha)
            pixels[x, y] = (red, green, blue, output_alpha)
    return transparent


def _radial_alpha_multiplier(x: int, y: int, width: int, height: int, spec: RadialFadeSpec) -> float:
    cx = (width - 1) / 2.0
    cy = (height - 1) / 2.0
    corners = ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1))
    max_radius = max(math.hypot(corner_x - cx, corner_y - cy) for corner_x, corner_y in corners)
    opaque_radius = (spec.opaque_percent / 100.0) * max_radius
    if max_radius == 0.0 or opaque_radius >= max_radius:
        return 1.0
    distance = math.hypot(float(x) - cx, float(y) - cy)
    if distance <= opaque_radius:
        return 1.0
    progress = _clamp_unit((distance - opaque_radius) / (max_radius - opaque_radius))
    return _clamp_unit(1.0 - (progress**spec.speed))


def _apply_radial_alpha_fade(image, spec: RadialFadeSpec):
    """Apply a center-out radial alpha fade and return an RGBA image."""

    faded = image.convert("RGBA")
    pixels = faded.load()
    width, height = faded.size
    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            multiplier = _radial_alpha_multiplier(x, y, width, height, spec)
            pixels[x, y] = (red, green, blue, _clamp_channel(float(alpha) * multiplier))
    return faded


def _contract_alpha(image, pixels: int):
    if pixels <= 0:
        return image
    _, ImageFilter = _load_pillow()
    alpha = image.getchannel("A")
    for _ in range(pixels):
        alpha = alpha.filter(ImageFilter.MinFilter(3))
    image.putalpha(alpha)
    return image


def _apply_edge_feather(image, radius: float):
    if radius <= 0:
        return image
    _, ImageFilter = _load_pillow()
    alpha = image.getchannel("A")
    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=radius))
    image.putalpha(alpha)
    return image


def _sample_border_key(image, mode: str) -> Color:
    width, height = image.size
    pixels = image.load()
    samples: list[Color] = []

    if mode == "corners":
        coords = [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]
    elif mode == "border":
        coords = []
        for x in range(width):
            coords.append((x, 0))
            coords.append((x, height - 1))
        for y in range(height):
            coords.append((0, y))
            coords.append((width - 1, y))
    else:
        raise ValueError("auto_key must be 'corners' or 'border'")

    for x, y in coords:
        red, green, blue = pixels[x, y][:3]
        samples.append((red, green, blue))
    if not samples:
        raise ValueError("could not sample background key color")
    return (int(median([item[0] for item in samples])), int(median([item[1] for item in samples])), int(median([item[2] for item in samples])))


def remove_chroma_key(
    input_path: str | Path,
    out: str | Path,
    *,
    key_color: str | Color = "#00ff00",
    auto_key: str | None = None,
    tolerance: int = 12,
    soft_matte: bool = True,
    transparent_threshold: int = 12,
    opaque_threshold: int = 220,
    edge_feather: float = 0.0,
    edge_contract: int = 0,
    spill_cleanup: bool = True,
) -> Path:
    """Remove a flat chroma-key background and save a PNG/WebP with alpha."""

    if not (0 <= tolerance <= 255):
        raise ValueError("tolerance must be between 0 and 255")
    if not (0 <= transparent_threshold <= 255 and 0 <= opaque_threshold <= 255):
        raise ValueError("alpha thresholds must be between 0 and 255")
    if soft_matte and transparent_threshold >= opaque_threshold:
        raise ValueError("transparent_threshold must be lower than opaque_threshold")
    if not (0 <= edge_feather <= 64):
        raise ValueError("edge_feather must be between 0 and 64")
    if not (0 <= edge_contract <= 16):
        raise ValueError("edge_contract must be between 0 and 16")

    Image, _ = _load_pillow()
    src = Path(input_path)
    out_path = Path(out)
    if out_path.suffix.lower() not in {".png", ".webp"}:
        raise ValueError("out must end in .png or .webp so the alpha channel is preserved")

    with Image.open(src) as image:
        rgba = image.convert("RGBA")
    key = _sample_border_key(rgba, auto_key) if auto_key else (key_color if isinstance(key_color, tuple) else parse_key_color(key_color))
    _apply_alpha_to_image(
        rgba,
        key=key,
        tolerance=tolerance,
        spill_cleanup=spill_cleanup,
        soft_matte=soft_matte,
        transparent_threshold=transparent_threshold,
        opaque_threshold=opaque_threshold,
    )
    rgba = _contract_alpha(rgba, edge_contract)
    rgba = _apply_edge_feather(rgba, edge_feather)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    output_format = "WEBP" if out_path.suffix.lower() == ".webp" else "PNG"
    buffer = BytesIO()
    rgba.save(buffer, format=output_format)
    out_path.write_bytes(buffer.getvalue())
    return out_path


__all__ = [
    "ensure_output_dirs",
    "frame_path",
    "save_sprite_sheet",
    "save_gif",
    "save_webp",
    "parse_grid",
    "parse_video_seconds",
    "parse_video_frame_size",
    "parse_radial_fade",
    "video_sample_times",
    "dominant_image_color",
    "near_square_columns",
    "extract_video_frames",
    "resize_framesheet",
    "framesheet_to_gif",
    "framesheet_to_webp",
    "validate_frame_sequence",
    "parse_key_color",
    "remove_chroma_key",
]

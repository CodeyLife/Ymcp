"""Local Pillow helpers for deterministic imagegen frame workflows.

The module intentionally performs no network calls and has no dependency on hosted
image-generation SDKs. Pillow is imported lazily so Ymcp can keep it as an
optional dependency for users who opt into local image generation.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import re
from statistics import median
from typing import Any, Iterable, Tuple

Color = Tuple[int, int, int]
KEY_DOMINANCE_THRESHOLD = 16.0
ALPHA_NOISE_FLOOR = 8


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


def _smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
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
    "validate_frame_sequence",
    "parse_key_color",
    "remove_chroma_key",
]

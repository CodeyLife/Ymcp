"""Generate shield-applied effect framesheet using Pillow."""

from PIL import Image, ImageDraw
from pathlib import Path
from ymcp.tools.imagegen.local_frame_workflow import (
    ensure_output_dirs,
    frame_path,
    save_sprite_sheet,
    save_gif,
    validate_frame_sequence,
    remove_chroma_key,
    near_square_columns,
)

SCRIPT_DIR = Path(__file__).parent.resolve()
CHROMA_KEY = (0, 255, 0)  # #00ff00

WIDTH, HEIGHT = 64, 64
CENTER = WIDTH // 2  # 32

charge_frames = 3
hold_frames = 2
burst_frames = 2
total_frames = charge_frames + hold_frames + burst_frames  # 7

decay_frames = 1
total_frames += decay_frames  # 8


def ease_in_cubic(t: float) -> float:
    return t * t * t


def ease_out_quad(t: float) -> float:
    return 1 - (1 - t) * (1 - t)


def ease_out_cubic(t: float) -> float:
    return 1 - (1 - t) ** 3


def draw_shield_frame(
    draw: ImageDraw.ImageDraw,
    radius: int,
    core_alpha: int,
    ring_alpha: int,
    ring_width: int,
    outer_radius: int = 0,
    outer_alpha: int = 0,
    outer_width: int = 0,
    glow_radius: int = 0,
    glow_alpha: int = 0,
) -> None:
    """Draw a shield effect with core, ring, and optional outer shockwave."""
    if glow_radius > 0 and glow_alpha > 0:
        draw.ellipse(
            (CENTER - glow_radius, CENTER - glow_radius, CENTER + glow_radius, CENTER + glow_radius),
            fill=(100, 180, 255, glow_alpha),
        )

    if outer_radius > 0 and outer_alpha > 0:
        draw.ellipse(
            (CENTER - outer_radius, CENTER - outer_radius, CENTER + outer_radius, CENTER + outer_radius),
            outline=(140, 200, 255, outer_alpha),
            width=outer_width,
        )

    if radius > 0 and ring_alpha > 0:
        draw.ellipse(
            (CENTER - radius, CENTER - radius, CENTER + radius, CENTER + radius),
            outline=(180, 220, 255, ring_alpha),
            width=ring_width,
        )

    if core_alpha > 0:
        core_r = max(4, radius // 3)
        draw.ellipse(
            (CENTER - core_r, CENTER - core_r, CENTER + core_r, CENTER + core_r),
            fill=(220, 240, 255, core_alpha),
        )


def render_chroma_frame(index: int) -> Image.Image:
    """Render a single frame on chroma-key background."""
    image = Image.new("RGB", (WIDTH, HEIGHT), CHROMA_KEY)
    draw = ImageDraw.Draw(image)

    if index < charge_frames:
        t = ease_in_cubic(index / max(1, charge_frames - 1))
        radius = int(8 + 14 * t)
        core_alpha = int(100 + 100 * t)
        ring_alpha = int(120 + 80 * t)
        ring_width = 2
        glow_radius = int(12 + 10 * t)
        glow_alpha = int(40 + 40 * t)
        draw_shield_frame(draw, radius, core_alpha, ring_alpha, ring_width, glow_radius=glow_radius, glow_alpha=glow_alpha)

    elif index < charge_frames + hold_frames:
        t = (index - charge_frames) / max(1, hold_frames - 1)
        radius = int(22 - 2 * (1 - t))
        core_alpha = int(200 + 55 * t)
        ring_alpha = int(200 + 40 * t)
        ring_width = 3
        glow_radius = int(22 - 2 * (1 - t))
        glow_alpha = int(80 + 20 * t)
        draw_shield_frame(draw, radius, core_alpha, ring_alpha, ring_width, glow_radius=glow_radius, glow_alpha=glow_alpha)

    elif index < charge_frames + hold_frames + burst_frames:
        t = ease_out_quad((index - charge_frames - hold_frames) / max(1, burst_frames - 1))
        radius = int(20 + 8 * t)
        core_alpha = int(255 - 50 * t)
        ring_alpha = 255
        ring_width = int(4 - 1 * t)
        outer_radius = int(24 + 6 * t)
        outer_alpha = int(180 + 40 * t)
        outer_width = 3
        glow_radius = int(20 + 6 * t)
        glow_alpha = int(100 + 50 * t)
        draw_shield_frame(draw, radius, core_alpha, ring_alpha, ring_width, outer_radius=outer_radius, outer_alpha=outer_alpha, outer_width=outer_width, glow_radius=glow_radius, glow_alpha=glow_alpha)

    else:
        t = ease_out_cubic((index - charge_frames - hold_frames - burst_frames) / max(1, decay_frames - 1) if decay_frames > 1 else 1)
        radius = int(28 - 6 * t)
        core_alpha = int(200 - 100 * t)
        ring_alpha = int(240 - 80 * t)
        ring_width = max(1, int(3 - 2 * t))
        outer_radius = int(30 - 4 * t)
        outer_alpha = int(220 - 100 * t)
        outer_width = max(1, int(3 - 2 * t))
        glow_radius = int(26 - 8 * t)
        glow_alpha = int(150 - 80 * t)
        draw_shield_frame(draw, radius, core_alpha, ring_alpha, ring_width, outer_radius=outer_radius, outer_alpha=outer_alpha, outer_width=outer_width, glow_radius=glow_radius, glow_alpha=glow_alpha)

    return image


def main():
    root, frames_dir = ensure_output_dirs(SCRIPT_DIR)
    transparent_frames_dir = root / "transparent_frames"
    transparent_frames_dir.mkdir(parents=True, exist_ok=True)

    print(f"Rendering {total_frames} chroma-key frames to {frames_dir}")
    chroma_paths = []
    for i in range(total_frames):
        img = render_chroma_frame(i)
        p = frame_path(frames_dir, i)
        img.save(p)
        chroma_paths.append(p)

    print(f"Converting to transparent frames in {transparent_frames_dir}")
    transparent_paths = []
    for i, chroma_path in enumerate(chroma_paths):
        tp = frame_path(transparent_frames_dir, i)
        remove_chroma_key(
            chroma_path,
            tp,
            auto_key="border",
            soft_matte=True,
            transparent_threshold=12,
            opaque_threshold=220,
            spill_cleanup=True,
        )
        transparent_paths.append(tp)

    from PIL import Image as PILImage
    frames = [PILImage.open(p) for p in transparent_paths]

    columns = near_square_columns(total_frames)
    sprite_path = root / "sprite.png"
    save_sprite_sheet(frames, sprite_path, columns=columns)
    print(f"Saved sprite sheet: {sprite_path} ({columns} columns)")

    gif_path = root / "preview.gif"
    save_gif(frames, gif_path, duration_ms=80, disposal=2)
    print(f"Saved preview GIF: {gif_path}")

    print("Validating...")
    report = validate_frame_sequence(
        transparent_frames_dir,
        expected_count=total_frames,
        expected_size=(WIDTH, HEIGHT),
        require_transparency=True,
        sprite_path=sprite_path,
        sprite_columns=columns,
    )
    print(f"Validation passed: {report}")

    print("Cleaning up temporary frames...")
    import shutil
    shutil.rmtree(frames_dir)
    shutil.rmtree(transparent_frames_dir)
    print("Cleanup complete. Final artifacts:")
    print(f"  - {sprite_path}")
    print(f"  - {gif_path}")


if __name__ == "__main__":
    main()

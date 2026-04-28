"""Generate a 4x4 blood splash animation framesheet (16 frames, 256x256)."""

import math
import random
from PIL import Image, ImageDraw
from ymcp.tools.imagegen.local_frame_workflow import (
    ensure_output_dirs,
    frame_path,
    save_gif,
    save_sprite_sheet,
    save_webp,
    validate_frame_sequence,
    remove_chroma_key,
)

random.seed(42)

WIDTH, HEIGHT = 256, 256
CENTER_X, CENTER_Y = 128, 128
FRAME_COUNT = 16
CHROMA_KEY = (0, 255, 0)

BLOOD_COLORS = [
    (139, 0, 0),
    (178, 34, 34),
    (220, 20, 60),
    (128, 0, 0),
    (165, 42, 42),
    (205, 92, 92),
]


def generate_droplets():
    """Pre-generate droplet paths for consistent animation across frames."""
    droplets = []
    num_droplets = random.randint(55, 75)
    for _ in range(num_droplets):
        angle = random.uniform(0, 2 * math.pi)
        speed = random.uniform(0.4, 1.4)
        size = random.randint(2, 10)
        color = random.choice(BLOOD_COLORS)
        gravity = random.uniform(0.5, 1.2)
        start_delay = random.randint(0, 1)
        droplets.append({
            "angle": angle,
            "speed": speed,
            "size": size,
            "color": color,
            "gravity": gravity,
            "start_delay": start_delay,
        })
    return droplets


def draw_blood_pool(draw, frame_idx):
    """No central circle - only droplets."""
    pass


def draw_droplet_trail(draw, droplet, frame_idx):
    """Draw a single droplet with sudden burst and gravity."""
    effective_frame = max(0, frame_idx - droplet["start_delay"])
    if effective_frame <= 0:
        return

    burst = 1.0 / (1.0 + effective_frame * 0.4)
    initial_speed = droplet["speed"] * 25
    distance = initial_speed * (1.0 - burst)
    if distance > 100:
        distance = 100

    dx = math.cos(droplet["angle"]) * distance
    dy = math.sin(droplet["angle"]) * distance + droplet["gravity"] * effective_frame * effective_frame * 0.8

    x = CENTER_X + int(dx)
    y = CENTER_Y + int(dy)

    if x < -20 or x > WIDTH + 20 or y < -20 or y > HEIGHT + 20:
        return

    size = max(1, droplet["size"] - int(effective_frame * 0.25))

    trail_length = min(effective_frame, 3)
    for t in range(trail_length, 0, -1):
        trail_burst = 1.0 / (1.0 + (effective_frame - t * 0.3) * 0.4)
        trail_dist = initial_speed * (1.0 - trail_burst)
        if trail_dist > 90:
            trail_dist = 90
        trail_dx = math.cos(droplet["angle"]) * trail_dist
        trail_dy = math.sin(droplet["angle"]) * trail_dist + droplet["gravity"] * (effective_frame - t * 0.3) ** 2 * 0.8
        trail_x = CENTER_X + int(trail_dx)
        trail_y = CENTER_Y + int(trail_dy)
        trail_size = max(1, int(size * (1.0 - t / (trail_length + 1.5))))
        trail_alpha = 0.7 - (t / (trail_length + 1))
        color = droplet["color"]
        trail_color = (
            max(0, int(color[0] * trail_alpha)),
            max(0, int(color[1] * trail_alpha)),
            max(0, int(color[2] * trail_alpha)),
        )
        draw.ellipse(
            [trail_x - trail_size, trail_y - trail_size, trail_x + trail_size, trail_y + trail_size],
            fill=trail_color,
        )

    if size >= 1:
        draw.ellipse(
            [x - size, y - size, x + size, y + size],
            fill=droplet["color"],
        )


def draw_splash_rings(draw, frame_idx):
    """Draw expanding splash rings from the impact point."""
    if frame_idx < 1:
        return
    num_rings = min(frame_idx, 3)
    for i in range(num_rings):
        ring_frame = frame_idx - i
        ring_radius = 18 + ring_frame * 14
        if ring_radius > 110:
            continue
        alpha = max(0.1, 1.0 - (ring_radius / 110.0))
        color = (
            int(160 * alpha),
            int(10 * alpha),
            int(10 * alpha),
        )
        draw.ellipse(
            [CENTER_X - ring_radius, CENTER_Y - ring_radius, CENTER_X + ring_radius, CENTER_Y + ring_radius],
            outline=color,
            width=max(1, 2 - i),
        )


def draw_micro_droplets(draw, frame_idx):
    """Draw tiny micro-droplets with burst and gravity."""
    if frame_idx < 1:
        return
    num_micro = min(frame_idx * 5, 30)
    for i in range(num_micro):
        random.seed(42 + frame_idx * 100 + i)
        angle = random.uniform(0, 2 * math.pi)
        burst = 1.0 / (1.0 + frame_idx * 0.3)
        dist = random.uniform(30, 80) * (1.0 - burst)
        spread = random.uniform(0.3, 1.0)
        x = CENTER_X + int(math.cos(angle) * dist * spread)
        y = CENTER_Y + int(math.sin(angle) * dist * spread + frame_idx * frame_idx * 0.5)
        size = random.randint(1, 3)
        color = random.choice(BLOOD_COLORS[:3])
        draw.ellipse(
            [x - size, y - size, x + size, y + size],
            fill=color,
        )


def draw_impact_sparkle(draw, frame_idx):
    """Draw initial impact sparkle/flash."""
    if frame_idx < 1 or frame_idx > 3:
        return
    sparkle_radius = frame_idx * 8
    for i in range(8):
        angle = (i / 8) * 2 * math.pi
        x = CENTER_X + int(math.cos(angle) * sparkle_radius * 0.5)
        y = CENTER_Y + int(math.sin(angle) * sparkle_radius * 0.5)
        draw.ellipse([x - 1, y - 1, x + 1, y + 1], fill=(255, 150, 150))


def generate_frame(frame_idx):
    """Generate a single frame of the blood splash animation."""
    image = Image.new("RGBA", (WIDTH, HEIGHT), (*CHROMA_KEY, 255))
    draw = ImageDraw.Draw(image)

    draw_blood_pool(draw, frame_idx)

    random.seed(42)
    droplets = generate_droplets()
    for droplet in droplets:
        draw_droplet_trail(draw, droplet, frame_idx)

    draw_micro_droplets(draw, frame_idx)

    return image


def main():
    root, frames_dir = ensure_output_dirs("output/imagegen/framesheet")

    print("Generating chroma-key frames...")
    frames = []
    for idx in range(FRAME_COUNT):
        frame = generate_frame(idx)
        path = frame_path(frames_dir, idx)
        frame.save(path)
        frames.append(frame)
        print(f"  Frame {idx:04d} saved to {path}")

    print("Removing chroma key for transparent frames...")
    transparent_frames_dir = root / "transparent_frames"
    transparent_frames_dir.mkdir(parents=True, exist_ok=True)
    transparent_frames = []
    for idx in range(FRAME_COUNT):
        src_path = frame_path(frames_dir, idx)
        out_path = transparent_frames_dir / f"frame_{idx:04d}.png"
        remove_chroma_key(
            str(src_path),
            str(out_path),
            auto_key="border",
            soft_matte=True,
            transparent_threshold=12,
            opaque_threshold=220,
            spill_cleanup=True,
        )
        from PIL import Image as PILImage
        with PILImage.open(out_path) as img:
            transparent_frames.append(img.copy())
        print(f"  Transparent frame {idx:04d} saved to {out_path}")

    print("Creating sprite sheet (4x4)...")
    sprite_path = root / "sprite.png"
    save_sprite_sheet(transparent_frames, sprite_path, columns=4)
    print(f"  Sprite sheet saved to {sprite_path}")

    print("Creating animated preview (GIF)...")
    gif_path = root / "preview.gif"
    save_gif(transparent_frames, gif_path, duration_ms=80, disposal=2)
    print(f"  GIF preview saved to {gif_path}")

    print("Creating animated preview (WebP)...")
    webp_path = root / "preview.webp"
    save_webp(transparent_frames, webp_path, duration_ms=80)
    print(f"  WebP preview saved to {webp_path}")

    print("Validating transparent frames...")
    report = validate_frame_sequence(
        str(transparent_frames_dir),
        expected_count=FRAME_COUNT,
        expected_size=(WIDTH, HEIGHT),
        require_transparency=True,
        sprite_path=str(sprite_path),
        sprite_columns=4,
    )
    print(f"  Validation report: {report}")

    print("Cleaning up temporary frames...")
    import shutil
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
        print(f"  Deleted {frames_dir}")
    if transparent_frames_dir.exists():
        shutil.rmtree(transparent_frames_dir)
        print(f"  Deleted {transparent_frames_dir}")

    print("Done! Final artifacts:")
    print(f"  - {sprite_path}")
    print(f"  - {gif_path}")
    print(f"  - {webp_path}")


if __name__ == "__main__":
    main()

---
name: imagegen
description: "Use for project-local bitmap or animation assets that should be generated deterministically with Python scripts and Pillow. The workflow has the model author or adjust a local Python script that renders sequence frames, post-processes them with Pillow, and saves all artifacts to the workspace. Animation assets must emphasize powerful impact rhythm: accelerating energy buildup, a short pre-impact hold, fast explosive energy pulses, shockwaves, and satisfying hit feedback. Do not use external image models, image APIs, remote generators, or API keys."
---

# Imagegen — Local Pillow Frame Workflow

Generate project-bound raster assets by writing and running local Python scripts. This skill is for deterministic bitmaps, sprites, simple illustrations, procedural textures, diagrams, placeholders, animation frames, sprite sheets, GIF/WebP previews, and transparent cutouts that can be produced with Pillow. For sprite sheets and animation frames, transparent output is the default unless the caller explicitly requests an opaque background.

For animation assets, prioritize forceful rhythm and hit satisfaction over evenly paced motion. Effects such as charged attacks, impacts, magic bursts, muzzle flashes, explosions, energy shields, and UI hit feedback should feel like they have weight: energy gathers with increasing speed, compresses briefly before contact, detonates in a sharp pulse, then decays through visible aftershock.

## Hard boundary

- Do not call remote image-generation APIs or SDKs.
- Do not require API keys or network access.
- Do not use hosted image models or built-in model-native image generation tools.
- The default implementation is: author a Python script, render temporary sequence frames with Pillow, post-process locally, validate, then keep only the final framesheet and animation preview unless the caller asks to retain per-frame sources.

## Default workflow

1. Determine the asset contract: purpose, dimensions, frame count, palette/style, transparency needs, target paths, and—when animated—the intended rhythm beats: buildup, anticipation hold, explosive impact, and aftershock decay.
2. Create or update a small project-local Python script for the asset under a task-appropriate workspace path, usually `output/imagegen/<slug>/generate.py` for generated artifacts or a committed helper/example path when the asset generator itself is part of the product.
3. Use Pillow to render frames into `output/imagegen/<slug>/frames/frame_0000.png` style paths. For animation, avoid linear per-frame changes unless the caller explicitly asks for a flat mechanical motion.
4. Use `ymcp.tools.imagegen.local_frame_workflow` helpers where useful for output directories, frame naming, sprite sheet composition, GIF/WebP export, and chroma-key removal.
5. Validate generated files locally: dimensions, number of frames, sprite dimensions, and alpha channel. When transparent output is expected, `validate_frame_sequence(..., require_transparency=True)` or equivalent Pillow checks must confirm alpha contains fully transparent pixels.
6. After validation, delete temporary per-frame directories such as `frames/` and `transparent_frames/`. Report final saved paths, frame count, validation evidence, cleanup evidence, animation rhythm beats when applicable, and known limitations. Do not report completion after only writing the script.

## Output conventions

- Default root: `output/imagegen/<slug>/`.
- Temporary frames: `output/imagegen/<slug>/frames/frame_0000.png` during generation only; remove before final handoff unless explicitly requested.
- Final handoff defaults: keep only `sprite.png` and `preview.gif` / `preview.webp`.
- Sprite sheet: `output/imagegen/<slug>/sprite.png`.
- Preview animation: `output/imagegen/<slug>/preview.gif` or `preview.webp`; GIF previews must use frame disposal so frames do not accumulate visually.
- Do not overwrite existing assets unless explicitly requested; otherwise use a new slug or version suffix.

## Animation impact rhythm

When generating an animated effect, design the timing first. The default target is a punchy "charge → hold → burst → recoil/decay" arc that creates 打击爽感 (satisfying hit feel). Do not spread motion evenly across all frames when the asset represents force, energy, or impact.

Recommended timing structure:

- **Energy buildup / charge:** Use non-linear acceleration. Particles, rings, glow, scale, or opacity should gather slowly at first, then tighten and brighten faster near the impact. Prefer quadratic/cubic ease-in, shrinking orbital radii, faster particle convergence, denser sparks, and rising contrast.
- **Pre-impact hold:** Add a short 1–3 frame pause, compression, darkening, or reverse pull immediately before the burst. This anticipation beat makes the following explosion feel stronger.
- **Explosive pulse:** Spend only 1–3 frames on the main detonation. Use high brightness, outward shock rings, overdrawn silhouettes, radial streaks, brief scale overshoot, screen-shake-like offsets, and abrupt expansion to communicate power.
- **Aftershock decay:** Let the effect dissipate quickly but visibly. Shockwaves expand and fade, sparks trail off, glow cools down, and debris/energy fragments continue outward so the impact has follow-through.

Implementation guidance:

- Encode rhythm explicitly in the script with named phases such as `charge_frames`, `hold_frames`, `burst_frames`, and `decay_frames`.
- Use easing functions and per-phase frame durations instead of constant speed. For GIF/WebP previews, vary `duration_ms` per frame if the helper supports it; otherwise duplicate hold/impact frames sparingly.
- Make the impact frame unmistakable: it should be the brightest, widest, sharpest, or most distorted frame in the sequence.
- For combat, attack, or hit-feedback assets, include at least one cue from each group unless the user asks otherwise: convergence cue, anticipation cue, shock/pulse cue, and residual decay cue.
- In the final report, identify the buildup range, hold frame(s), burst frame(s), and decay range so reviewers can verify the rhythm, not just the file dimensions.

## Script pattern

```python
from PIL import Image, ImageDraw
from ymcp.tools.imagegen.local_frame_workflow import (
    ensure_output_dirs,
    frame_path,
    save_gif,
    save_sprite_sheet,
    validate_frame_sequence,
)

root, frames_dir = ensure_output_dirs("output/imagegen/example")

charge_frames = 7
hold_frames = 2
burst_frames = 2
decay_frames = 5
total_frames = charge_frames + hold_frames + burst_frames + decay_frames


def ease_in_cubic(t: float) -> float:
    return t * t * t


def ease_out_quad(t: float) -> float:
    return 1 - (1 - t) * (1 - t)


frames = []
for index in range(total_frames):
    image = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if index < charge_frames:
        # Energy gathers with accelerating speed: radius shrinks, glow brightens.
        t = ease_in_cubic(index / max(1, charge_frames - 1))
        radius = int(86 - 54 * t)
        glow = int(80 + 150 * t)
        draw.ellipse((128 - radius, 128 - radius, 128 + radius, 128 + radius), outline=(80, 180, 255, glow), width=5)
        draw.ellipse((112, 112, 144, 144), fill=(120, 220, 255, glow))
    elif index < charge_frames + hold_frames:
        # Short compressed pause before impact.
        draw.ellipse((106, 106, 150, 150), fill=(255, 255, 255, 230))
        draw.ellipse((96, 96, 160, 160), outline=(60, 120, 255, 180), width=4)
    elif index < charge_frames + hold_frames + burst_frames:
        # Fast explosive energy pulse and shockwave.
        t = (index - charge_frames - hold_frames) / max(1, burst_frames - 1)
        shock = int(54 + 58 * t)
        draw.ellipse((128 - shock, 128 - shock, 128 + shock, 128 + shock), outline=(120, 220, 255, 240), width=8)
        draw.ellipse((72, 72, 184, 184), fill=(255, 245, 170, 220))
    else:
        # Visible aftershock decay.
        t = ease_out_quad((index - charge_frames - hold_frames - burst_frames) / max(1, decay_frames - 1))
        shock = int(96 + 72 * t)
        alpha = int(180 * (1 - t))
        draw.ellipse((128 - shock, 128 - shock, 128 + shock, 128 + shock), outline=(120, 220, 255, alpha), width=5)

    path = frame_path(frames_dir, index)
    image.save(path)
    frames.append(image)

save_sprite_sheet(frames, root / "sprite.png", columns=4)
save_gif(frames, root / "preview.gif", duration_ms=70, disposal=2)
validate_frame_sequence(frames_dir, expected_count=total_frames, expected_size=(256, 256), sprite_path=root / "sprite.png", sprite_columns=4)
```

## Transparent / cutout workflow

For generated subjects that need transparent output, render source frames on a flat chroma-key background and use local alpha conversion instead of model-native transparency. Prefer a key color that does not appear in the subject, commonly `#00ff00` or `#ff00ff`, then call `remove_chroma_key` from `ymcp.tools.imagegen.local_frame_workflow`.

Transparent source requirements:

- Render the subject on one perfectly flat solid chroma-key background.
- Use `#00ff00` by default; use `#ff00ff` when the subject is green or green-adjacent.
- Do not draw shadows, gradients, texture, reflections, floor planes, or key-colored details in the subject.
- Save transparent frame outputs under `transparent_frames/` only as temporary working files while composing final assets.
- Build `sprite.png` and the animation preview from `transparent_frames/`, not from the chroma-key source frames.
- White, black, or same-color matte backgrounds are not transparency; validate the alpha channel.
- After validation, delete `frames/`, `transparent_frames/`, and any other per-frame PNG directories unless explicitly requested.

Minimal cutout post-processing example:

```python
from ymcp.tools.imagegen.local_frame_workflow import remove_chroma_key

remove_chroma_key(
    "output/imagegen/example/frames/frame_0000.png",
    "output/imagegen/example/transparent_frames/frame_0000.png",
    auto_key="border",
    soft_matte=True,
    transparent_threshold=12,
    opaque_threshold=220,
    spill_cleanup=True,
)
```

After post-processing, validate transparent outputs:

```python
from ymcp.tools.imagegen.local_frame_workflow import validate_frame_sequence

validate_frame_sequence(
    "output/imagegen/example/transparent_frames",
    expected_count=16,
    expected_size=(256, 256),
    require_transparency=True,
    sprite_path="output/imagegen/example/sprite.png",
    sprite_columns=4,
)
```

## When not to use

- Photorealistic image synthesis or complex semantic image editing that cannot reasonably be scripted with Pillow.
- Existing vector/SVG/UI assets where direct vector or code edits are more appropriate.
- Any task that requires external image services; this project-local workflow intentionally excludes them.

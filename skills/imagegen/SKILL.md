---
name: imagegen
description: "Use for project-local bitmap or animation assets that should be generated deterministically with Python scripts and Pillow. The workflow has the model author or adjust a local Python script that renders sequence frames, post-processes them with Pillow, and saves all artifacts to the workspace. Do not use external image models, image APIs, remote generators, or API keys."
---

# Imagegen — Local Pillow Frame Workflow

Generate project-bound raster assets by writing and running local Python scripts. This skill is for deterministic bitmaps, sprites, simple illustrations, procedural textures, diagrams, placeholders, animation frames, sprite sheets, GIF/WebP previews, and transparent cutouts that can be produced with Pillow. For sprite sheets and animation frames, transparent output is the default unless the caller explicitly requests an opaque background.

## Hard boundary

- Do not call remote image-generation APIs or SDKs.
- Do not require API keys or network access.
- Do not use hosted image models or built-in model-native image generation tools.
- The default implementation is: author a Python script, render temporary sequence frames with Pillow, post-process locally, validate, then keep only the final framesheet and animation preview unless the caller asks to retain per-frame sources.

## Default workflow

1. Determine the asset contract: purpose, dimensions, frame count, palette/style, transparency needs, and target paths.
2. Create or update a small project-local Python script for the asset under a task-appropriate workspace path, usually `output/imagegen/<slug>/generate.py` for generated artifacts or a committed helper/example path when the asset generator itself is part of the product.
3. Use Pillow to render frames into `output/imagegen/<slug>/frames/frame_0000.png` style paths.
4. Use `ymcp.tools.imagegen.local_frame_workflow` helpers where useful for output directories, frame naming, sprite sheet composition, GIF/WebP export, and chroma-key removal.
5. Validate generated files locally: dimensions, number of frames, sprite dimensions, and alpha channel. When transparent output is expected, `validate_frame_sequence(..., require_transparency=True)` or equivalent Pillow checks must confirm alpha contains fully transparent pixels.
6. After validation, delete temporary per-frame directories such as `frames/` and `transparent_frames/`. Report final saved paths, frame count, validation evidence, cleanup evidence, and known limitations. Do not report completion after only writing the script.

## Output conventions

- Default root: `output/imagegen/<slug>/`.
- Temporary frames: `output/imagegen/<slug>/frames/frame_0000.png` during generation only; remove before final handoff unless explicitly requested.
- Final handoff defaults: keep only `sprite.png` and `preview.gif` / `preview.webp`.
- Sprite sheet: `output/imagegen/<slug>/sprite.png`.
- Preview animation: `output/imagegen/<slug>/preview.gif` or `preview.webp`; GIF previews must use frame disposal so frames do not accumulate visually.
- Do not overwrite existing assets unless explicitly requested; otherwise use a new slug or version suffix.

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
frames = []
for index in range(12):
    image = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((32 + index * 8, 96, 96 + index * 8, 160), fill=(255, 180, 40, 255))
    path = frame_path(frames_dir, index)
    image.save(path)
    frames.append(image)

save_sprite_sheet(frames, root / "sprite.png", columns=4)
save_gif(frames, root / "preview.gif", duration_ms=80, disposal=2)
validate_frame_sequence(frames_dir, expected_count=12, expected_size=(256, 256), sprite_path=root / "sprite.png", sprite_columns=4)
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

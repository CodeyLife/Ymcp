from pathlib import Path

import pytest

Image = pytest.importorskip("PIL.Image")

from ymcp.tools.imagegen.local_frame_workflow import (
    ensure_output_dirs,
    frame_path,
    remove_chroma_key,
    save_gif,
    save_sprite_sheet,
    validate_frame_sequence,
)


def test_local_frame_workflow_writes_frames_sprite_and_gif(tmp_path):
    root, frames_dir = ensure_output_dirs(tmp_path / "asset")
    frames = []

    for index in range(3):
        image = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
        for x in range(index + 1):
            image.putpixel((x, index), (255, 0, 0, 255))
        path = frame_path(frames_dir, index)
        image.save(path)
        frames.append(image)

    sprite = save_sprite_sheet(frames, root / "sprite.png", columns=2, padding=1)
    gif = save_gif(frames, root / "preview.gif", duration_ms=20)

    assert [path.name for path in sorted(frames_dir.glob("*.png"))] == [
        "frame_0000.png",
        "frame_0001.png",
        "frame_0002.png",
    ]
    assert sprite.exists()
    assert gif.exists()
    with Image.open(sprite) as sprite_image:
        assert sprite_image.size == (17, 17)
        assert sprite_image.mode == "RGBA"


def test_remove_chroma_key_preserves_subject_and_adds_alpha(tmp_path):
    source = tmp_path / "source.png"
    output = tmp_path / "cutout.png"
    image = Image.new("RGB", (5, 5), (0, 255, 0))
    image.putpixel((2, 2), (255, 0, 0))
    image.save(source)

    result = remove_chroma_key(source, output, auto_key="border", soft_matte=False)

    assert result == output
    with Image.open(output) as cutout:
        assert cutout.mode == "RGBA"
        assert cutout.getpixel((0, 0))[3] == 0
        assert cutout.getpixel((2, 2)) == (255, 0, 0, 255)


def test_frame_path_validates_index_and_extension(tmp_path):
    assert frame_path(tmp_path, 12, ext="webp").name == "frame_0012.webp"
    with pytest.raises(ValueError):
        frame_path(tmp_path, -1)
    with pytest.raises(ValueError):
        frame_path(tmp_path, 0, ext="bmp")


def test_validate_frame_sequence_accepts_transparent_sprite(tmp_path):
    root, frames_dir = ensure_output_dirs(tmp_path / "transparent")
    frames = []
    for index in range(4):
        image = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
        image.putpixel((index, index), (200, 0, 0, 255))
        image.save(frame_path(frames_dir, index))
        frames.append(image)
    sprite = save_sprite_sheet(frames, root / "sprite.png", columns=2)

    report = validate_frame_sequence(
        frames_dir,
        expected_count=4,
        expected_size=(8, 8),
        require_transparency=True,
        sprite_path=sprite,
        sprite_columns=2,
    )

    assert report["frame_count"] == 4
    assert report["sprite_size"] == [16, 16]


def test_validate_frame_sequence_rejects_opaque_frames(tmp_path):
    _, frames_dir = ensure_output_dirs(tmp_path / "opaque")
    for index in range(2):
        Image.new("RGBA", (8, 8), (255, 255, 255, 255)).save(frame_path(frames_dir, index))

    with pytest.raises(ValueError, match="fully transparent pixels"):
        validate_frame_sequence(frames_dir, expected_count=2, expected_size=(8, 8), require_transparency=True)


def test_validate_frame_sequence_rejects_wrong_sprite_size(tmp_path):
    root, frames_dir = ensure_output_dirs(tmp_path / "sprite")
    frames = []
    for index in range(4):
        image = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
        image.putpixel((0, 0), (200, 0, 0, 255))
        image.save(frame_path(frames_dir, index))
        frames.append(image)
    wrong_sprite = save_sprite_sheet(frames, root / "sprite.png", columns=4)

    with pytest.raises(ValueError, match="expected"):
        validate_frame_sequence(
            frames_dir,
            expected_count=4,
            expected_size=(8, 8),
            require_transparency=True,
            sprite_path=wrong_sprite,
            sprite_columns=2,
        )


def test_save_gif_uses_restore_background_disposal(tmp_path):
    frames = []
    for index in range(2):
        image = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
        image.putpixel((index, index), (255, 0, 0, 255))
        frames.append(image)

    gif = save_gif(frames, tmp_path / "preview.gif", duration_ms=20)

    with Image.open(gif) as animation:
        assert animation.n_frames == 2
        animation.seek(0)
        assert animation.disposal_method == 2
        animation.seek(1)
        assert animation.disposal_method == 2

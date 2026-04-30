from pathlib import Path

import pytest

Image = pytest.importorskip("PIL.Image")

from ymcp.tools.imagegen.local_frame_workflow import (
    dominant_image_color,
    extract_video_frames,
    ensure_output_dirs,
    frame_path,
    framesheet_to_gif,
    framesheet_to_webp,
    near_square_columns,
    parse_grid,
    parse_radial_fade,
    parse_video_frame_size,
    parse_video_seconds,
    remove_chroma_key,
    resize_framesheet,
    save_gif,
    save_sprite_sheet,
    validate_frame_sequence,
    video_sample_times,
)
import ymcp.tools.imagegen.local_frame_workflow as local_frame_workflow


def _webp_anmf_flags(path: Path) -> list[int]:
    data = path.read_bytes()
    offset = 12
    flags = []
    while offset + 8 <= len(data):
        chunk_type = data[offset : offset + 4]
        chunk_size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        payload_offset = offset + 8
        if chunk_type == b"ANMF":
            flags.append(data[payload_offset + 15])
        offset = payload_offset + chunk_size + (chunk_size % 2)
    return flags


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


def test_save_sprite_sheet_preserves_rgba_source_alpha(tmp_path):
    image = Image.new("RGBA", (2, 1), (0, 0, 0, 0))
    image.putpixel((0, 0), (255, 0, 0, 128))
    image.putpixel((1, 0), (0, 255, 0, 255))

    sprite = save_sprite_sheet([image], tmp_path / "sprite.png", columns=1)

    with Image.open(sprite) as sprite_image:
        assert sprite_image.getpixel((0, 0)) == (255, 0, 0, 128)
        assert sprite_image.getpixel((1, 0)) == (0, 255, 0, 255)


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


def test_parse_radial_fade_accepts_default_percent_and_speed():
    assert parse_radial_fade(None).opaque_percent == 80.0
    assert parse_radial_fade(None).speed == 1.0
    assert parse_radial_fade("default").opaque_percent == 80.0
    assert parse_radial_fade("80").opaque_percent == 80.0
    assert parse_radial_fade("80.0").opaque_percent == 80.0
    assert parse_radial_fade("80%").opaque_percent == 80.0

    percent_and_speed = parse_radial_fade("80%-1.5")
    assert percent_and_speed.opaque_percent == 80.0
    assert percent_and_speed.speed == 1.5

    compact = parse_radial_fade("80-2")
    assert compact.opaque_percent == 80.0
    assert compact.speed == 2.0


@pytest.mark.parametrize("raw", ["", "abc", "-1", "101", "80-0", "80--1"])
def test_parse_radial_fade_rejects_invalid_values(raw):
    with pytest.raises(ValueError):
        parse_radial_fade(raw)


def test_apply_radial_alpha_fade_preserves_center_and_fades_corner():
    image = Image.new("RGBA", (11, 11), (255, 0, 0, 255))

    faded = local_frame_workflow._apply_radial_alpha_fade(image, parse_radial_fade("80"))

    assert faded.mode == "RGBA"
    assert faded.getpixel((5, 5))[3] == 255
    assert faded.getpixel((0, 0))[3] == 0


def test_apply_radial_alpha_fade_handles_boundaries_and_tiny_images():
    image = Image.new("RGBA", (3, 3), (255, 0, 0, 128))
    unchanged = local_frame_workflow._apply_radial_alpha_fade(image, parse_radial_fade("100"))
    assert list(unchanged.getdata()) == list(image.getdata())

    tiny = Image.new("RGBA", (1, 1), (255, 0, 0, 128))
    faded_tiny = local_frame_workflow._apply_radial_alpha_fade(tiny, parse_radial_fade("0"))
    assert faded_tiny.getpixel((0, 0))[3] == 128


def test_apply_radial_alpha_fade_multiplies_existing_alpha():
    image = Image.new("RGBA", (5, 5), (255, 0, 0, 255))
    image.putpixel((4, 2), (255, 0, 0, 128))
    spec = parse_radial_fade("0")

    faded = local_frame_workflow._apply_radial_alpha_fade(image, spec)
    expected_multiplier = local_frame_workflow._radial_alpha_multiplier(4, 2, 5, 5, spec)

    assert faded.getpixel((4, 2))[3] == round(128 * expected_multiplier)


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


def test_parse_grid_accepts_cols_by_rows():
    assert parse_grid("4x3") == (4, 3)
    assert parse_grid("2X5") == (2, 5)
    with pytest.raises(ValueError):
        parse_grid("4*4")
    with pytest.raises(ValueError):
        parse_grid("0x4")


def test_parse_video_seconds_accepts_duration_and_range():
    assert parse_video_seconds(None) is None
    assert parse_video_seconds("2") == (0.0, 2.0)
    assert parse_video_seconds("1-2") == (1.0, 2.0)
    with pytest.raises(ValueError):
        parse_video_seconds("2-1")
    with pytest.raises(ValueError):
        parse_video_seconds("-2")


def test_parse_video_frame_size_accepts_square_full_and_rectangle():
    assert parse_video_frame_size(None) == (256, 256)
    assert parse_video_frame_size("256") == (256, 256)
    assert parse_video_frame_size("320x180") == (320, 180)
    assert parse_video_frame_size("full") is None
    with pytest.raises(ValueError):
        parse_video_frame_size("0")


def test_video_sample_times_evenly_cover_segment_without_sampling_end():
    assert video_sample_times(1, 1.0, 3.0) == [2.0]
    assert video_sample_times(3, 1.0, 4.0) == [1.5, 2.5, 3.5]
    with pytest.raises(ValueError):
        video_sample_times(0, 0.0, 1.0)


def test_near_square_columns_prefers_factor_at_or_below_square_root():
    assert near_square_columns(24) == 4
    assert near_square_columns(20) == 4
    assert near_square_columns(16) == 4
    assert near_square_columns(7) == 1
    with pytest.raises(ValueError):
        near_square_columns(0)


def test_dominant_image_color_returns_most_common_rgb():
    image = Image.new("RGB", (3, 2), (0, 255, 0))
    image.putpixel((0, 0), (255, 0, 0))

    assert dominant_image_color(image) == (0, 255, 0)


def test_default_video_frames_dir_uses_current_video_frames_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    assert local_frame_workflow._default_video_frames_dir(Path("C:/videos/clip.mp4")) == tmp_path / "video_frames"
    assert local_frame_workflow._default_video_frames_dir("https://example.com/clip.mp4") == tmp_path / "video_frames"


def test_force_webp_replace_dispose_rewrites_animation_flags(tmp_path):
    out = tmp_path / "anim.webp"
    frames = [
        Image.new("RGBA", (4, 4), (0, 0, 0, 0)),
        Image.new("RGBA", (4, 4), (0, 0, 0, 0)),
    ]
    frames[0].putpixel((0, 0), (255, 0, 0, 255))
    frames[1].putpixel((1, 1), (0, 0, 255, 255))
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=100, loop=0, lossless=True)

    local_frame_workflow._force_webp_replace_dispose(out)

    assert _webp_anmf_flags(out) == [0b10, 0b10]


def test_extract_video_frames_uses_ffmpeg_and_pillow_resize(tmp_path, monkeypatch):
    png = tmp_path / "source.png"
    Image.new("RGB", (12, 8), (255, 0, 0)).save(png)
    png2 = tmp_path / "source2.png"
    Image.new("RGB", (12, 8), (0, 255, 0)).save(png2)
    png3 = tmp_path / "source3.png"
    Image.new("RGB", (12, 8), (0, 0, 255)).save(png3)
    png_bytes = [png.read_bytes(), png2.read_bytes(), png3.read_bytes()]
    calls = []

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.shutil.which", lambda name: name)

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[0] == "ffprobe":
            return type("Completed", (), {"returncode": 0, "stdout": "4.0\n", "stderr": ""})()
        if "libwebp_anim" in command:
            Image.new("RGB", (6, 4), (255, 0, 0)).save(tmp_path / "frames" / "animation.webp", save_all=True, append_images=[Image.new("RGB", (6, 4), (0, 255, 0)), Image.new("RGB", (6, 4), (0, 0, 255))], duration=100, loop=0)
            return type("Completed", (), {"returncode": 0, "stdout": b"", "stderr": b""})()
        return type("Completed", (), {"returncode": 0, "stdout": png_bytes.pop(0), "stderr": b""})()

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.subprocess.run", fake_run)

    out_dir = extract_video_frames("clip.mp4", 3, tmp_path / "frames", seconds="1-2", size="6x4", remove_background=False)

    assert out_dir == tmp_path / "frames"
    assert [path.name for path in sorted(out_dir.iterdir())] == ["animation.webp", "framesheet.png"]
    with Image.open(out_dir / "framesheet.png") as sheet:
        assert sheet.mode == "RGBA"
        assert sheet.size == (6, 12)
        assert sheet.getpixel((0, 0))[3] == 0
        assert sheet.getpixel((3, 2))[:3] == (255, 0, 0)
        assert sheet.getpixel((3, 2))[3] == 255
    with Image.open(out_dir / "animation.webp") as animation:
        assert getattr(animation, "is_animated", False)
        assert animation.n_frames == 3
        assert animation.size == (6, 4)
    extract_calls = [call for call in calls if "-ss" in call]
    assert [call[call.index("-ss") + 1] for call in extract_calls] == ["1.166667", "1.500000", "1.833333"]
    assert any("libwebp_anim" in call for call in calls)


def test_extract_video_frames_probes_duration_when_seconds_omitted(tmp_path, monkeypatch):
    png = tmp_path / "source.png"
    Image.new("RGB", (12, 8), (255, 0, 0)).save(png)
    png_bytes = png.read_bytes()

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.shutil.which", lambda name: name)

    def fake_run(command, **kwargs):
        if command[0] == "ffprobe":
            return type("Completed", (), {"returncode": 0, "stdout": "4.0\n", "stderr": ""})()
        if "libwebp_anim" in command:
            Image.new("RGB", (12, 8), (255, 0, 0)).save(tmp_path / "frames" / "animation.webp")
            return type("Completed", (), {"returncode": 0, "stdout": b"", "stderr": b""})()
        return type("Completed", (), {"returncode": 0, "stdout": png_bytes, "stderr": b""})()

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.subprocess.run", fake_run)

    out_dir = extract_video_frames("clip.mp4", 1, tmp_path / "frames", size="full", remove_background=False)

    with Image.open(out_dir / "framesheet.png") as sheet:
        assert sheet.size == (12, 8)
        assert sheet.mode == "RGBA"


def test_probe_video_duration_prefers_conservative_decodable_duration(monkeypatch):
    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.shutil.which", lambda name: name)

    def fake_run(command, **kwargs):
        return type(
            "Completed",
            (),
            {
                "returncode": 0,
                "stdout": '{"streams":[{"nb_frames":"24","avg_frame_rate":"12/1"}],"format":{"duration":"2.083333"}}',
                "stderr": "",
            },
        )()

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.subprocess.run", fake_run)

    assert local_frame_workflow._probe_video_duration("clip.mp4") == 2.0


def test_extract_video_frame_png_retries_before_undecodable_timestamp(tmp_path, monkeypatch):
    png = tmp_path / "source.png"
    Image.new("RGB", (4, 4), (255, 0, 0)).save(png)
    calls = []

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.shutil.which", lambda name: name)

    def fake_run(command, **kwargs):
        timestamp = float(command[command.index("-ss") + 1])
        calls.append(timestamp)
        if timestamp > 2.0:
            return type("Completed", (), {"returncode": 0, "stdout": b"", "stderr": b""})()
        return type("Completed", (), {"returncode": 0, "stdout": png.read_bytes(), "stderr": b""})()

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.subprocess.run", fake_run)

    assert local_frame_workflow._extract_video_frame_png("clip.mp4", 2.04, min_timestamp=0.0) == png.read_bytes()
    assert calls == [2.04, 1.99]


def test_extract_video_frames_removes_dominant_first_frame_background(tmp_path, monkeypatch):
    first = tmp_path / "first.png"
    first_image = Image.new("RGB", (4, 4), (0, 255, 0))
    first_image.putpixel((1, 1), (255, 0, 0))
    first_image.save(first)
    second = tmp_path / "second.png"
    second_image = Image.new("RGB", (4, 4), (0, 255, 0))
    second_image.putpixel((2, 2), (0, 0, 255))
    second_image.save(second)
    png_bytes = [first.read_bytes(), second.read_bytes()]

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.shutil.which", lambda name: name)

    def fake_run(command, **kwargs):
        if command[0] == "ffprobe":
            return type("Completed", (), {"returncode": 0, "stdout": "4.0\n", "stderr": ""})()
        if "libwebp_anim" in command:
            Image.new("RGBA", (4, 4), (255, 0, 0, 255)).save(tmp_path / "frames" / "animation.webp", save_all=True, append_images=[Image.new("RGBA", (4, 4), (0, 0, 255, 255))], duration=100, loop=0)
            return type("Completed", (), {"returncode": 0, "stdout": b"", "stderr": b""})()
        return type("Completed", (), {"returncode": 0, "stdout": png_bytes.pop(0), "stderr": b""})()

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.subprocess.run", fake_run)

    out_dir = extract_video_frames("clip.mp4", 2, tmp_path / "frames", seconds="0-1", size="full", remove_background=True, columns=1)

    assert not list(out_dir.glob("frame_*.png"))
    with Image.open(out_dir / "framesheet.png") as sheet:
        assert sheet.mode == "RGBA"
        assert sheet.size == (4, 8)
        assert sheet.getpixel((0, 0))[3] == 0
        assert sheet.getpixel((1, 1))[3] == 255
        assert sheet.getpixel((0, 4))[3] == 0
        assert sheet.getpixel((2, 6))[3] == 255


def test_resize_framesheet_resamples_grid_to_target_frame_size(tmp_path):
    source = tmp_path / "sheet.png"
    image = Image.new("RGB", (20, 20), (0, 0, 0))
    for x in range(10):
        for y in range(10):
            image.putpixel((x, y), (255, 0, 0))
            image.putpixel((x + 10, y), (0, 255, 0))
            image.putpixel((x, y + 10), (0, 0, 255))
            image.putpixel((x + 10, y + 10), (255, 255, 0))
    image.save(source)

    out = resize_framesheet(source, "2x2", frame_size=256)

    with Image.open(out) as resized:
        assert resized.size == (512, 512)
        assert resized.mode == "RGB"
        assert resized.getpixel((128, 128)) == (255, 0, 0)
        assert resized.getpixel((384, 128)) == (0, 255, 0)


def test_resize_framesheet_preserves_alpha_and_refuses_overwrite(tmp_path):
    source = tmp_path / "sheet.png"
    image = Image.new("RGBA", (8, 4), (0, 0, 0, 0))
    image.putpixel((1, 1), (255, 0, 0, 255))
    image.putpixel((5, 1), (0, 255, 0, 128))
    image.save(source)
    out = tmp_path / "out.png"

    resize_framesheet(source, "2x1", out, frame_size=16)
    with Image.open(out) as resized:
        assert resized.size == (32, 16)
        assert resized.mode == "RGBA"
        assert resized.getchannel("A").getextrema()[0] == 0

    with pytest.raises(FileExistsError):
        resize_framesheet(source, "2x1", out, frame_size=16)


def test_framesheet_to_gif_uses_row_major_order_and_optional_size(tmp_path):
    source = tmp_path / "sheet.png"
    image = Image.new("RGB", (20, 20), (0, 0, 0))
    quadrants = [
        ((0, 0), (255, 0, 0)),
        ((10, 0), (0, 255, 0)),
        ((0, 10), (0, 0, 255)),
        ((10, 10), (255, 255, 0)),
    ]
    for (left, upper), color in quadrants:
        for x in range(left, left + 10):
            for y in range(upper, upper + 10):
                image.putpixel((x, y), color)
    image.save(source)

    out = framesheet_to_gif(source, "2x2", tmp_path / "anim.gif", frame_size=16, duration_ms=30)

    with Image.open(out) as animation:
        assert animation.n_frames == 4
        assert animation.size == (16, 16)
        expected = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
        for index, color in enumerate(expected):
            animation.seek(index)
            assert animation.convert("RGB").getpixel((8, 8)) == color
            assert animation.disposal_method == 2


def test_framesheet_to_gif_refuses_overwrite(tmp_path):
    source = tmp_path / "sheet.png"
    Image.new("RGB", (8, 8), (255, 0, 0)).save(source)
    out = tmp_path / "anim.gif"

    framesheet_to_gif(source, "1x1", out)

    with pytest.raises(FileExistsError):
        framesheet_to_gif(source, "1x1", out, overwrite=False)


def test_framesheet_to_webp_uses_row_major_order_and_optional_size(tmp_path):
    source = tmp_path / "sheet.png"
    image = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
    quadrants = [
        ((0, 0), (255, 0, 0, 255)),
        ((10, 0), (0, 255, 0, 255)),
        ((0, 10), (0, 0, 255, 255)),
        ((10, 10), (255, 255, 0, 128)),
    ]
    for (left, upper), color in quadrants:
        for x in range(left, left + 10):
            for y in range(upper, upper + 10):
                image.putpixel((x, y), color)
    image.save(source)

    out = framesheet_to_webp(source, "2x2", tmp_path / "anim.webp", frame_size=16, duration_ms=30)

    with Image.open(out) as animation:
        assert getattr(animation, "is_animated", False)
        assert animation.n_frames == 4
        assert animation.size == (16, 16)
        expected = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
        for index, color in enumerate(expected):
            animation.seek(index)
            assert animation.convert("RGB").getpixel((8, 8)) == color


def test_framesheet_to_webp_refuses_overwrite(tmp_path):
    source = tmp_path / "sheet.png"
    Image.new("RGB", (8, 8), (255, 0, 0)).save(source)
    out = tmp_path / "anim.webp"

    framesheet_to_webp(source, "1x1", out)

    with pytest.raises(FileExistsError):
        framesheet_to_webp(source, "1x1", out, overwrite=False)

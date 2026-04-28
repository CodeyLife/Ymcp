import json
import subprocess
import sys

import pytest
from pathlib import Path

from ymcp.cli import main
from ymcp.contracts.memory import MEMPALACE_TOOL_SCHEMAS

WORKFLOW_NAMES = {'ydeep', 'ydeep_menu', 'yplan', 'yplan_architect', 'yplan_critic', 'yplan_menu', 'ydo', 'ydo_menu', 'yimggen'}
MEMORY_NAMES = {tool['name'] for tool in MEMPALACE_TOOL_SCHEMAS}
EXPECTED_NAMES = WORKFLOW_NAMES | MEMORY_NAMES
RESOURCE_URIS = {
    'resource://ymcp/principles',
    'resource://ymcp/memory-protocol',
    'resource://ymcp/workflow-contracts',
    'resource://ymcp/project-rule-template',
}
PROMPT_NAMES = {
    'architect',
    'critic',
    'deep-interview',
    'imagegen',
    'plan',
    'planner',
    'ralph',
    'ralplan',
    'workflow-menu',
}


def test_inspect_tools_json_command(capsys):
    assert main(['inspect-tools', '--json']) == 0
    payload = json.loads(capsys.readouterr().out)
    assert {item['name'] for item in payload} == EXPECTED_NAMES


def test_inspect_resources_json_command(capsys):
    assert main(['inspect-resources', '--json']) == 0
    payload = json.loads(capsys.readouterr().out)
    assert {item['uri'] for item in payload} == RESOURCE_URIS


def test_inspect_prompts_json_command(capsys):
    assert main(['inspect-prompts', '--json']) == 0
    payload = json.loads(capsys.readouterr().out)
    assert {item['name'] for item in payload} == PROMPT_NAMES


def test_call_fixture_json_for_all_tools(capsys):
    for tool_name in ['ydeep', 'ydeep_menu', 'yplan', 'yplan_architect', 'yplan_critic', 'yplan_menu', 'ydo', 'ydo_menu', 'yimggen', 'mempalace_status']:
        assert main(['call-fixture', tool_name, '--json']) == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload['meta']['tool_name'] == tool_name


def test_example_host_call_all_tools_runs():
    completed = subprocess.run([sys.executable, 'examples/host_call_all_tools.py'], check=True, capture_output=True, text=True)
    assert 'ydeep:' in completed.stdout
    assert 'ydeep_menu:' in completed.stdout
    assert 'yplan:' in completed.stdout
    assert 'yplan_architect:' in completed.stdout
    assert 'yplan_critic:' in completed.stdout
    assert 'yplan_menu:' in completed.stdout
    assert 'ydo:' in completed.stdout
    assert 'ydo_menu:' in completed.stdout
    assert 'yimggen:' in completed.stdout


def test_frame_command_resizes_framesheet(tmp_path, capsys):
    Image = pytest.importorskip("PIL.Image")
    source = tmp_path / "sheet.png"
    image = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    image.putpixel((1, 1), (255, 0, 0, 255))
    image.save(source)
    out = tmp_path / "resized.png"

    assert main(["frame", "2x2", str(source), "--out", str(out)]) == 0
    assert str(out) in capsys.readouterr().out
    with Image.open(out) as resized:
        assert resized.size == (512, 512)
        assert resized.mode == "RGBA"

    assert main(["frame", "2x2", str(source), "--out", str(out), "--no-overwrite"]) == 1


def test_frame_command_rejects_bad_grid(tmp_path):
    Image = pytest.importorskip("PIL.Image")
    source = tmp_path / "sheet.png"
    Image.new("RGB", (16, 16), (0, 0, 0)).save(source)

    assert main(["frame", "2*2", str(source)]) == 1


def test_frame_gif_command_builds_gif(tmp_path, capsys):
    Image = pytest.importorskip("PIL.Image")
    source = tmp_path / "sheet.png"
    image = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    for x in range(8):
        for y in range(8):
            image.putpixel((x, y), (255, 0, 0, 255))
            image.putpixel((x + 8, y), (0, 255, 0, 255))
            image.putpixel((x, y + 8), (0, 0, 255, 255))
            image.putpixel((x + 8, y + 8), (255, 255, 0, 255))
    image.save(source)
    out = tmp_path / "sheet.gif"

    assert main(["frame-gif", "2x2", str(source), "--out", str(out), "--duration", "30", "--size", "16"]) == 0
    assert str(out) in capsys.readouterr().out
    with Image.open(out) as animation:
        assert animation.n_frames == 4
        assert animation.size == (16, 16)

    assert main(["frame-gif", "2x2", str(source), "--out", str(out), "--no-overwrite"]) == 1


def test_frame_gif_command_rejects_bad_grid(tmp_path):
    Image = pytest.importorskip("PIL.Image")
    source = tmp_path / "sheet.png"
    Image.new("RGB", (16, 16), (0, 0, 0)).save(source)

    assert main(["frame-gif", "2*2", str(source)]) == 1


def test_frame_webp_command_builds_webp(tmp_path, capsys):
    Image = pytest.importorskip("PIL.Image")
    source = tmp_path / "sheet.png"
    image = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    for x in range(8):
        for y in range(8):
            image.putpixel((x, y), (255, 0, 0, 255))
            image.putpixel((x + 8, y), (0, 255, 0, 255))
            image.putpixel((x, y + 8), (0, 0, 255, 255))
            image.putpixel((x + 8, y + 8), (255, 255, 0, 128))
    image.save(source)
    out = tmp_path / "sheet.webp"

    assert main(["frame-webp", "2x2", str(source), "--out", str(out), "--duration", "30", "--size", "16"]) == 0
    assert str(out) in capsys.readouterr().out
    with Image.open(out) as animation:
        assert getattr(animation, "is_animated", False)
        assert animation.n_frames == 4
        assert animation.size == (16, 16)

    assert main(["frame_webp", "2x2", str(source), "--out", str(out), "--no-overwrite"]) == 1


def test_frame_webp_command_rejects_bad_grid(tmp_path):
    Image = pytest.importorskip("PIL.Image")
    source = tmp_path / "sheet.png"
    Image.new("RGB", (16, 16), (0, 0, 0)).save(source)

    assert main(["frame-webp", "2*2", str(source)]) == 1


def test_video_frames_command_writes_framesheet_and_webp(tmp_path, capsys, monkeypatch):
    Image = pytest.importorskip("PIL.Image")
    source = tmp_path / "source.png"
    Image.new("RGB", (12, 8), (255, 0, 0)).save(source)
    source2 = tmp_path / "source2.png"
    Image.new("RGB", (12, 8), (0, 255, 0)).save(source2)
    source_bytes = [source.read_bytes(), source2.read_bytes()]

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.shutil.which", lambda name: name)

    def fake_run(command, **kwargs):
        if "libwebp_anim" in command:
            Image.new("RGB", (6, 4), (255, 0, 0)).save(out / "animation.webp", save_all=True, append_images=[Image.new("RGB", (6, 4), (0, 255, 0))], duration=100, loop=0)
            return type("Completed", (), {"returncode": 0, "stdout": b"", "stderr": b""})()
        return type("Completed", (), {"returncode": 0, "stdout": source_bytes.pop(0), "stderr": b""})()

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.subprocess.run", fake_run)

    out = tmp_path / "frames"
    assert main(["v2f", "2", "clip.mp4", "--seconds", "1-2", "--out", str(out), "--size", "6x4", "--keep-bg"]) == 0
    assert str(out) in capsys.readouterr().out
    assert [path.name for path in sorted(out.iterdir())] == ["animation.webp", "framesheet.png"]
    assert not list(out.glob("frame_*.png"))
    with Image.open(out / "framesheet.png") as sheet:
        assert sheet.size == (6, 8)
    with Image.open(out / "animation.webp") as animation:
        assert getattr(animation, "is_animated", False)
        assert animation.n_frames == 2
        assert animation.size == (6, 4)

    assert main(["video_frames", "2", "clip.mp4", "--seconds", "1-2", "--out", str(out), "--no-overwrite"]) == 1


def test_video_frames_command_can_remove_background(tmp_path, monkeypatch):
    Image = pytest.importorskip("PIL.Image")
    source = tmp_path / "source.png"
    image = Image.new("RGB", (4, 4), (0, 255, 0))
    image.putpixel((1, 1), (255, 0, 0))
    image.save(source)
    source_bytes = source.read_bytes()

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.shutil.which", lambda name: name)

    def fake_run(command, **kwargs):
        if "libwebp_anim" in command:
            Image.new("RGBA", (4, 4), (255, 0, 0, 255)).save(out / "animation.webp")
            return type("Completed", (), {"returncode": 0, "stdout": b"", "stderr": b""})()
        return type("Completed", (), {"returncode": 0, "stdout": source_bytes, "stderr": b""})()

    monkeypatch.setattr("ymcp.tools.imagegen.local_frame_workflow.subprocess.run", fake_run)

    out = tmp_path / "frames"
    assert main(["v2f", "1", "clip.mp4", "--seconds", "1", "--out", str(out), "--size", "full"]) == 0
    with Image.open(out / "framesheet.png") as sheet:
        assert sheet.mode == "RGBA"
        assert sheet.getpixel((0, 0))[3] == 0
        assert sheet.getpixel((1, 1))[3] == 255

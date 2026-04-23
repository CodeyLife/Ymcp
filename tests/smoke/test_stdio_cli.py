import os
import subprocess
import sys
import time
from pathlib import Path

from ymcp.cli import main


def test_ymcp_serve_starts_and_keeps_stdout_for_protocol():
    env = os.environ.copy()
    env["PYTHONPATH"] = str(Path("src").resolve())
    process = subprocess.Popen(
        [sys.executable, "-m", "ymcp.cli", "serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        time.sleep(0.75)
        assert process.poll() is None
    finally:
        process.terminate()
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=5)
    assert "INFO" not in stdout
    assert "ERROR" not in stdout


def test_configure_logging_does_not_write_to_stdout(capsys):
    from ymcp.server import configure_logging

    configure_logging()
    captured = capsys.readouterr()
    assert captured.out == ""

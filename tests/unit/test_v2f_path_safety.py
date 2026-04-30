from pathlib import Path

import pytest

from ymcp.tools.imagegen.session import resolve_safe_path


def test_resolve_safe_path_accepts_path_inside_base(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    target = base / "out"
    target.mkdir()

    assert resolve_safe_path(target, base=base) == target.resolve()


def test_resolve_safe_path_requires_existing_path_when_requested(tmp_path):
    with pytest.raises(FileNotFoundError):
        resolve_safe_path(tmp_path / "missing.txt", must_exist=True)


def test_resolve_safe_path_blocks_parent_traversal(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    traversal = base / ".." / "outside"

    with pytest.raises(ValueError):
        resolve_safe_path(traversal, base=base)

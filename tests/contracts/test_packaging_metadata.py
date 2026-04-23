import tomllib
from pathlib import Path


def test_pyproject_has_release_metadata():
    data = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    project = data["project"]
    assert project["name"] == "ymcp"
    assert project["license"] == "MIT"
    assert "license-files" in project
    assert "Trae" not in project["description"]  # package remains host-general despite Trae-first docs
    assert {"Homepage", "Documentation", "Issues", "Source"} <= set(project["urls"])
    assert "build>=1.2,<2" in project["optional-dependencies"]["dev"]
    assert "twine>=6,<7" in project["optional-dependencies"]["dev"]


def test_release_workflows_exist():
    assert Path(".github/workflows/ci.yml").exists()
    release = Path(".github/workflows/release.yml").read_text(encoding="utf-8")
    assert "test.pypi.org" in release
    assert "pypa/gh-action-pypi-publish" in release
    assert "id-token: write" in release

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib
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
    assert "pillow>=10,<12" in project["optional-dependencies"]["imagegen"]


def test_imagegen_skill_is_packaged():
    data = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    assert "/skills" in data["tool"]["hatch"]["build"]["targets"]["sdist"]["include"]
    force_include = data["tool"]["hatch"]["build"]["targets"]["wheel"]["force-include"]
    assert force_include["skills"] == "skills"
    skill = Path("skills/imagegen/SKILL.md").read_text(encoding="utf-8")
    assert "Pillow" in skill
    assert "API key" in skill


def test_release_workflows_exist():
    assert Path(".github/workflows/ci.yml").exists()
    release = Path(".github/workflows/release.yml").read_text(encoding="utf-8")
    assert "test.pypi.org" in release
    assert "pypa/gh-action-pypi-publish" in release
    assert "id-token: write" in release

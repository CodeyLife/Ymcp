import json
from pathlib import Path


def test_docs_include_install_update_and_trae_example():
    readme = Path("README.md").read_text(encoding="utf-8")
    install = Path("docs/install.md").read_text(encoding="utf-8")
    trae = Path("docs/trae-integration.md").read_text(encoding="utf-8")
    reference = Path("docs/tool-reference.md").read_text(encoding="utf-8")
    assert "pip install ymcp" in install
    assert "pip install -U ymcp" in install
    assert "Trae" in readme
    assert "ymcp print-config --host trae" in trae
    assert "宿主边界" in trae
    for name in ["plan", "ralplan", "deep_interview", "ralph"]:
        assert name in reference
        assert name in trae


def test_trae_config_example_is_parseable():
    payload = json.loads(Path("examples/trae_mcp_config.example.json").read_text(encoding="utf-8"))
    assert payload["mcpServers"]["ymcp"]["command"] == "ymcp"
    assert payload["mcpServers"]["ymcp"]["args"] == ["serve"]


def test_release_docs_include_testpypi_then_pypi_gate():
    checklist = Path("docs/release-checklist.md").read_text(encoding="utf-8")
    assert "TestPyPI" in checklist
    assert "PyPI" in checklist
    assert "python -m build" in checklist




def test_project_rule_template_exists_and_is_chinese_oriented():
    template = Path("docs/trae-project-rule-template.md").read_text(encoding="utf-8")
    assert "Ymcp 项目规则" in template
    assert ".trae/rules" not in template or "规则" in template
    assert "deep_interview" in template
    assert "ralph" in template

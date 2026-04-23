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
    assert "memory_store" in reference
    for name in ["plan", "ralplan", "deep_interview", "ralph", "memory_search", "memory_status"]:
        assert name in reference


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
    assert "项目规则" in template
    assert "deep_interview" in template
    assert "ralph" in template


def test_trae_memory_prompt_guide_is_present():
    trae = Path("docs/trae-integration.md").read_text(encoding="utf-8")
    readme = Path("README.md").read_text(encoding="utf-8")
    reference = Path("docs/tool-reference.md").read_text(encoding="utf-8")
    assert "记忆工具使用指南" in trae
    assert "Trae 可复制 prompt 示例" in trae
    assert "先查再写" in trae
    assert "memory_store" in trae
    assert "memory_search" in trae
    assert "memory_get" in trae
    assert "memory_update" in trae
    assert "memory_delete" in trae
    assert "记忆写入安全提醒" in trae
    assert "Trae 中常用记忆 prompt" in readme
    assert "Trae 调用建议" in reference


def test_workflow_state_machine_docs_present():
    trae = Path("docs/trae-integration.md").read_text(encoding="utf-8")
    reference = Path("docs/tool-reference.md").read_text(encoding="utf-8")
    assert "状态机投影" in trae
    assert "宿主负责循环" in trae
    assert "deep_interview" in trae and "ralplan" in trae and "ralph" in trae
    assert "workflow_state" in reference



def test_trae_workflow_prompt_templates_present():
    trae = Path("docs/trae-integration.md").read_text(encoding="utf-8")
    readme = Path("README.md").read_text(encoding="utf-8")
    reference = Path("docs/tool-reference.md").read_text(encoding="utf-8")
    assert "Workflow 最佳调用链" in trae
    assert "Workflow 专用 Trae Prompt 模板" in trae
    assert "deep_interview 多轮澄清模板" in trae
    assert "plan 直接规划模板" in trae
    assert "ralplan Planner 阶段模板" in trae
    assert "ralplan Architect → Critic 阶段模板" in trae
    assert "ralph 执行验证模板" in trae
    assert "完成后记忆沉淀模板" in trae
    assert "deep_interview → ralplan → ralph → memory_store" in readme
    assert "推荐组合链路" in reference



def test_memory_preflight_docs_present():
    trae = Path("docs/trae-integration.md").read_text(encoding="utf-8")
    reference = Path("docs/tool-reference.md").read_text(encoding="utf-8")
    assert "工作流开始前读取记忆" in trae
    assert "workflow_state.memory_preflight" in trae
    assert "memory_search" in trae
    assert "known_context" in trae
    assert "memory_preflight" in reference


import json
from pathlib import Path

from ymcp.docs.template import TRAE_PROJECT_RULE_TEMPLATE


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
    assert "mempalace_add_drawer" in reference
    for name in ["plan", "ralplan", "deep_interview", "ralph", "mempalace_search", "mempalace_status"]:
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
    assert "mempalace_add_drawer" in trae
    assert "mempalace_search" in trae
    assert "mempalace_get_drawer" in trae
    assert "mempalace_update_drawer" in trae
    assert "mempalace_delete_drawer" in trae
    assert "记忆写入安全提醒" in trae
    assert "Trae 中常用记忆 prompt" in readme
    assert "Trae 调用建议" in reference
    assert "Memory Protocol" in trae
    assert "mempalace_diary_write" in trae
    assert "mempalace_kg_invalidate" in trae
    assert "Memory Protocol" in readme


def test_workflow_state_machine_docs_present():
    trae = Path("docs/trae-integration.md").read_text(encoding="utf-8")
    reference = Path("docs/tool-reference.md").read_text(encoding="utf-8")
    contract = Path("docs/workflow-contract.md").read_text(encoding="utf-8")
    assert "状态机投影" in trae
    assert "宿主负责循环" in trae
    assert "deep_interview" in trae and "ralplan" in trae and "ralph" in trae
    assert "workflow_state" in reference
    assert "字段职责分层" in contract
    assert "summary" in contract and "phase_summary" in contract and "workflow_state" in contract



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
    assert "deep_interview → ralplan → ralph → mempalace_add_drawer" in readme
    assert "推荐组合链路" in reference



def test_memory_preflight_docs_present():
    trae = Path("docs/trae-integration.md").read_text(encoding="utf-8")
    reference = Path("docs/tool-reference.md").read_text(encoding="utf-8")
    assert "工作流开始前读取记忆" in trae
    assert "workflow_state.memory_preflight" in trae
    assert "mempalace_search" in trae
    assert "known_context" in trae
    assert "memory_preflight" in reference


def test_project_rule_template_contains_memory_protocol_rules():
    template = TRAE_PROJECT_RULE_TEMPLATE
    assert "mempalace_search" in template
    assert "不要在 Elicitation 节点直接结束对话" in template
    assert "docs/workflow-contract.md" in template


def test_elicitation_docs_require_options_instead_of_ending_conversation():
    host = Path("docs/host-integration.md").read_text(encoding="utf-8")
    contract = Path("docs/workflow-contract.md").read_text(encoding="utf-8")
    guide = Path("docs/host-implementation-guide.md").read_text(encoding="utf-8")
    assert "不要在 Elicitation 节点直接结束对话" in host
    assert "展示官方 Elicitation 选项" in host
    assert "不要在 Elicitation 节点直接结束对话" in guide
    assert "当前流程停在需要显式选择/输入的节点" in guide
    assert "不应在 Elicitation 节点直接结束对话" in contract or "不要用结束文案收尾" in contract


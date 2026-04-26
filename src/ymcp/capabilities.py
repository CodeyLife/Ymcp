from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ymcp.contracts.workflow import MEMORY_PROTOCOL_STEPS
from ymcp.docs.template import TRAE_PROJECT_RULE_TEMPLATE


ROOT_DIR = Path(__file__).resolve().parents[2]
SKILLS_DIR = ROOT_DIR / "skills"


@dataclass(frozen=True)
class ResourceSpec:
    uri: str
    name: str
    title: str
    description: str
    mime_type: str
    content: str


@dataclass(frozen=True)
class PromptSpec:
    name: str
    title: str
    description: str
    argument_names: tuple[str, ...]
    content: str


def _memory_protocol_content() -> str:
    lines = ["# Ymcp Memory Protocol", "", "记忆能力作为 MCP Tools 暴露。", ""]
    lines.extend(f"{index}. {step}" for index, step in enumerate(MEMORY_PROTOCOL_STEPS, 1))
    return "\n".join(lines) + "\n"


PRINCIPLES_CONTENT = """# Ymcp FastMCP 第一原则

- 保留 `ydeep`、`ydeep_complete`、`yplan`、`yplan_architect`、`yplan_critic`、`yplan_complete`、`ydo`、`ydo_complete` 等 workflow tools。
- tool 负责阶段 gate 与下一步约束；prompt 负责内部思考方法。
- 运行时硬约束以 prompts、tool descriptions 和 tool contract 为准。
"""


def _parse_skill_frontmatter(text: str, fallback_name: str) -> tuple[str, str]:
    if not text.startswith("---"):
        return fallback_name, f"{fallback_name} skill prompt"
    parts = text.split("---", 2)
    if len(parts) < 3:
        return fallback_name, f"{fallback_name} skill prompt"
    frontmatter = parts[1]
    name = fallback_name
    description = f"{fallback_name} skill prompt"
    for raw_line in frontmatter.splitlines():
        line = raw_line.strip()
        if line.startswith("name:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("description:"):
            description = line.split(":", 1)[1].strip()
    return name, description


def _load_skill_prompt_specs() -> tuple[PromptSpec, ...]:
    specs: list[PromptSpec] = []
    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        skill_file = skill_dir / "SKILL.md"
        if not skill_dir.is_dir() or not skill_file.exists():
            continue
        content = skill_file.read_text(encoding="utf-8")
        name, description = _parse_skill_frontmatter(content, skill_dir.name)
        specs.append(
            PromptSpec(
                name=name,
                title=name,
                description=description,
                argument_names=("arguments",),
                content=content,
            )
        )
    return tuple(specs)


PROMPT_SPECS: tuple[PromptSpec, ...] = _load_skill_prompt_specs()


def get_resource_specs() -> tuple[ResourceSpec, ...]:
    return (
        ResourceSpec("resource://ymcp/principles", "ymcp_principles", "Ymcp FastMCP 第一原则", "Workflow tool 与 prompt 的边界说明。", "text/markdown", PRINCIPLES_CONTENT),
        ResourceSpec("resource://ymcp/memory-protocol", "ymcp_memory_protocol", "Ymcp Memory Protocol", "记忆核验、写入、更新、失效和安全规则。", "text/markdown", _memory_protocol_content()),
        ResourceSpec("resource://ymcp/project-rule-template", "ymcp_project_rule_template", "Ymcp Project Rule Template", "Trae / LLM 宿主项目规则模板。", "text/markdown", TRAE_PROJECT_RULE_TEMPLATE),
    )


def get_prompt_specs() -> tuple[PromptSpec, ...]:
    return PROMPT_SPECS


def prompt_template(name: str, **kwargs: Any) -> str:
    prompt = next((spec for spec in PROMPT_SPECS if spec.name == name), None)
    if prompt is None:
        raise KeyError(f"unknown prompt template: {name}")
    arguments = str(kwargs.get("arguments") or "").strip()
    if not arguments:
        return prompt.content
    return f"{prompt.content.rstrip()}\n\nTask / Arguments:\n{arguments}\n"


def prompt_content(name: str, arguments: str = "") -> str:
    return prompt_template(name, arguments=arguments)

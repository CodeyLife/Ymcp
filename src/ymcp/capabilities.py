from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ymcp.contracts.workflow import MEMORY_PROTOCOL_STEPS
from ymcp.docs.template import TRAE_PROJECT_RULE_TEMPLATE


ROOT_DIR = Path(__file__).resolve().parents[2]


def _resolve_skills_dir() -> Path:
    module_path = Path(__file__).resolve()
    candidates = (
        module_path.parents[2] / "skills",  # source checkout: <repo>/skills
        module_path.parents[1] / "skills",  # installed wheel: <site-packages>/skills
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


SKILLS_DIR = _resolve_skills_dir()


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

- 保留 `ydeep`、`yplan`、`ydo` 三个 workflow 入口与唯一公开 `menu` 流程菜单 tool。
- tool 负责阶段 gate、统一 handoff、Elicitation 与 WebUI fallback；prompt 负责内部思考方法。
- 运行时硬约束以 prompts、tool descriptions 和 tool contract 为准。
"""

WORKFLOW_CONTRACTS_CONTENT = """# Ymcp Workflow Contracts

## Public workflow tools

- Public workflow surface:
  - `ydeep`
  - `yplan`
  - `ydo`
  - `menu`
- `ydeep`, `yplan`, and `ydo` return stage `skill_content`.
- After the model finishes the stage task and outputs a visible summary, it calls `menu`.
- `menu` is the only public workflow handoff tool.

## menu

- `menu` accepts:
  - `source_workflow`
  - `summary`
  - `options`
  - optional `selected_option`
  - optional `webui_timeout_seconds`
- `options` are the sole authoritative next-step menu source.
- `menu` first tries MCP Elicitation.
- If Elicitation is unsupported, failed, declined, cancelled, or returns an illegal option, `menu` starts a localhost WebUI fallback and returns `blocked` with `meta.ui_request.webui_url`.
- WebUI fallback is an interactive control, not a markdown/text menu.
- The host/model must not auto-select `recommended_next_action`.

## ydeep

- `ydeep` returns `deep-interview` skill guidance.
- After clarification is complete, the model outputs a summary and calls `menu` with options:
  - `yplan`
  - `refine_further`

## yplan

- `yplan` accepts only `task`.
- `yplan` returns `planner` skill guidance.
- The `plan` skill performs planner / architect / critic thinking internally; `yplan_architect` and `yplan_critic` are no longer public tools.
- After the plan is approved or needs a new planning pass, the model outputs a summary and calls `menu` with options:
  - `ydo`
  - `yplan`
  - `memory_store`

## ydo

- `ydo` starts execution from current conversation context and no longer requires an `approved_plan_artifact` input.
- After execution and verification, the model outputs a summary and calls `menu` with options:
  - `finish`
  - `memory_store`
  - `yplan`
  - `continue_execution`

## yimggen

- `yimggen` starts the local image generation workflow.
- It returns `imagegen` skill guidance plus deterministic output-path conventions for Python/Pillow sequence-frame generation.
- It does not call remote image APIs, does not use external image models, and does not execute arbitrary generated scripts.

## Design rule

Ymcp is a lightweight skill-flow server. The tool contract only declares:
- the current phase skill guidance
- the legal next-step options
- the recommended next step

`handoff.options` should be treated as a server-provided action menu, not a route object the model is expected to construct.

The intended interaction is:
1. tool returns `skill_content`
2. model thinks and outputs
3. model outputs the stage summary and calls `menu` with explicit options
4. `menu` uses `handoff.options` as the Elicitation / WebUI interactive-control source and waits for user choice where supported
5. if Elicitation is unavailable or fails, `menu` returns `blocked` plus `webui_url`; `handoff.options` remains the authoritative menu payload
6. menu `workflow_state` moves through explicit statuses such as `ready_for_handoff`, `elicitation_requested`, `awaiting_user_selection`, and `selection_confirmed`

The host owns the fixed calling convention between stages. Ymcp does not try to be a fully automatic workflow state machine.
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
        ResourceSpec("resource://ymcp/workflow-contracts", "ymcp_workflow_contracts", "Ymcp Workflow Contracts", "三条 workflow 的 artifact 流转与 handoff 参数绑定说明。", "text/markdown", WORKFLOW_CONTRACTS_CONTENT),
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

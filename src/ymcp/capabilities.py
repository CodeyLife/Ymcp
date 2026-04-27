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

WORKFLOW_CONTRACTS_CONTENT = """# Ymcp Workflow Contracts

## ydeep

- `ydeep` returns `skill_content` and a single next-step option: `ydeep_complete`
- `ydeep_complete` returns `clarified_artifact` plus two Elicitation options:
  - `yplan`
  - `refine_further`
- Host convention:
  - when the user/model chooses `yplan`, convert `clarified_artifact.summary` into the plain `task` input expected by `yplan`
  - when the user/model chooses `refine_further`, stay in the same interview loop and call `ydeep_complete` again after more thinking
  - `recommended_next_action` is only a recommendation; the host / model must not auto-select it
  - if the host cannot execute MCP Elicitation, `ydeep_complete` should block rather than silently succeeding

## yplan

- `yplan` accepts only:
  - `task`
- `yplan` returns planner `skill_content` and a single next-step option: `yplan_architect`
- `yplan_architect` returns architect `skill_content` and a single next-step option: `yplan_critic`
- `yplan_critic` returns critic `skill_content` and exactly two legal next-step options:
  - `yplan`
  - `yplan_complete`
- Host convention:
  - the host converts upstream artifacts into a plain planning task before calling `yplan`
    - from `ydeep_complete`, use `clarified_artifact.summary` as `task`
    - from execution/replanning, use the new planning brief or execution findings as a fresh plain `task`
  - the model finishes the planner stage, then calls `yplan_architect`
  - the model finishes the architect stage, outputs an architecture review summary, then in the same turn calls `yplan_critic` with `architect_summary`; stopping after the summary is not a valid handoff
  - inside `yplan_critic`, the model decides for itself whether the plan is ready:
    - if ready, make approval explicit, produce a brief critic approval summary, and then call `yplan_complete` with `critic_summary`; do not stop at the approval text and do not call complete with only `schema_version`
    - if not ready, restart planning by calling `yplan`
  - Ymcp does not require a fixed critic verdict schema such as `APPROVE/REVISE`; the legal next-step options are the contract
  - `yplan_complete` is a handoff-only completion gate; calling it with `critic_summary` means the model believes planning is complete
  - `yplan_complete` does not produce the final business conclusion and does not auto-start execution; it only returns the legal next-step options after critic approval evidence is present

## ydo

- `yplan_complete` returns `ydo` as a legal next step
- `ydo` returns execution `skill_content` and the next-step option `ydo_complete`
- `ydo_complete` returns four Elicitation options:
  - `finish`
  - `memory_store`
  - `yplan`
  - `continue_execution`
- Host convention:
  - `ydo` is entered directly from the current conversation context; it no longer requires an `approved_plan_artifact` input
  - when the user/model chooses `yplan` after execution, restart planning by passing a fresh plain `task`
  - `ydo_complete` is also a no-input completion gate; `continue_execution` means stay in the execution loop and call `ydo_complete` again after more work

## Design rule

Ymcp is a lightweight skill-flow server. The tool contract only declares:
- the current phase skill guidance
- the legal next-step options
- the recommended next step

`handoff.options` should be treated as a server-provided action menu, not a route object the model is expected to construct.

The intended interaction is:
1. tool returns `skill_content`
2. model thinks and outputs
3. host calls the matching `*_complete`
4. for complete stages, host should use `handoff.options` as the Elicitation / interactive-control menu source and wait for user choice; the model should stop analysis and must not render a markdown/text menu
5. if Elicitation is unavailable or fails, complete stages should return `blocked`; `handoff.options` remains the authoritative menu payload, not a silent-success fallback
6. complete-stage `workflow_state` should move through explicit handoff statuses such as `ready_for_handoff`, `elicitation_requested`, `awaiting_user_selection`, and `selection_confirmed`

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

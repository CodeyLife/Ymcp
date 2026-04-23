from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ymcp.contracts.workflow import MEMORY_PROTOCOL_STEPS
from ymcp.docs.template import TRAE_PROJECT_RULE_TEMPLATE
from ymcp.internal_registry import get_tool_specs


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


def _tool_reference_content() -> str:
    workflow = [spec for spec in get_tool_specs() if not spec.name.startswith("memory_")]
    memory = [spec for spec in get_tool_specs() if spec.name.startswith("memory_")]
    lines = [
        "# Ymcp MCP 能力参考：Tools",
        "",
        "Ymcp 的 Tool 只负责执行动作、查询外部系统或产生结构化结果。需要用户输入/选择时优先使用 MCP Elicitation；客户端不支持时返回 needs_input / blocked 等标准结构化结果。",
        "",
        "## Workflow Tools",
    ]
    lines.extend(f"- `{spec.name}`：{spec.description}" for spec in workflow)
    lines.extend(["", "## Memory Tools"])
    lines.extend(f"- `{spec.name}`：{spec.description}" for spec in memory)
    return "\n".join(lines) + "\n"


def _memory_protocol_content() -> str:
    lines = [
        "# Ymcp Memory Protocol",
        "",
        "记忆能力作为 MCP Tools 暴露；长期上下文本身也通过本 Resource 提供给宿主作为只读规则。",
        "",
    ]
    lines.extend(f"{index}. {step}" for index, step in enumerate(MEMORY_PROTOCOL_STEPS, 1))
    lines.extend(
        [
            "",
            "## 写入与更新规则",
            "",
            "- 写入前先用 `memory_search` 或 `memory_check_duplicate` 查重。",
            "- 只保存稳定偏好、项目约定、重要决策和可复用踩坑结论。",
            "- 不保存密钥、隐私或未经确认的敏感信息。",
            "- 事实变化时优先更新/删除旧记忆或使 KG 关系失效，再写入新事实。",
        ]
    )
    return "\n".join(lines) + "\n"


PRINCIPLES_CONTENT = """# Ymcp FastMCP 第一原则

Ymcp 的第一原则是：一切能力优先按 FastMCP / MCP 官方标准三原语组织。

## 三原语边界

- Tools：执行动作、查询外部系统、产生结构化结果。
- Resources：暴露可读取上下文、项目原则、规则模板、工具参考、记忆协议。
- Prompts：暴露可复用调用模板和标准工作流提示；Prompt 不直接执行工具，也不伪造工具结果。

## Elicitation

当 Tool 执行中需要用户输入、选择或表单字段时，优先使用 MCP 官方 Elicitation。客户端不支持 Elicitation 时，Tool 返回标准 `needs_input` / `blocked` 结构化结果，说明缺失输入和可继续方式。

## 禁止

- 禁止用自定义宿主协议替代 MCP Tools / Resources / Prompts / Elicitation。
- 禁止把文档型上下文只放在 Markdown 中而不暴露为 Resource。
- 禁止把可复用提示只写在文档中而不暴露为 Prompt。
- 禁止把 Ymcp 描述为 agent runtime，或声称它会自动执行、自动修改、自动验证。
"""


HOST_INTEGRATION_CONTENT = """# Ymcp Host Integration

Ymcp 默认使用 stdio 传输，并以 MCP-first 能力边界集成到 Trae、Claude Desktop 或其他 MCP 宿主。

## 推荐配置

```json
{
  "mcpServers": {
    "ymcp": {
      "command": "ymcp",
      "args": ["serve"],
      "env": {}
    }
  }
}
```

## MCP-first 使用约束

- 宿主应优先发现并消费 Tools / Resources / Prompts 三类能力，而不是只读取 Markdown 文档。
- 规则、参考和协议上下文从 `resource://ymcp/*` 读取。
- 可复用 workflow 话术从 Prompt 获取，再由宿主决定是否展示或调用 Tool。
- 如果客户端支持 Elicitation，必须处理服务器发起的表单/选择请求。
- 如果客户端不支持 Elicitation，不要伪造用户输入；只根据 Tool 返回的标准结构化结果继续。
"""


def get_resource_specs() -> tuple[ResourceSpec, ...]:
    return (
        ResourceSpec(
            uri="resource://ymcp/principles",
            name="ymcp_principles",
            title="Ymcp FastMCP 第一原则",
            description="FastMCP 第一原则、三原语边界、Elicitation 规则和禁止项。",
            mime_type="text/markdown",
            content=PRINCIPLES_CONTENT,
        ),
        ResourceSpec(
            uri="resource://ymcp/tool-reference",
            name="ymcp_tool_reference",
            title="Ymcp Tool Reference",
            description="当前 workflow tools 和 memory tools 的标准用途。",
            mime_type="text/markdown",
            content=_tool_reference_content(),
        ),
        ResourceSpec(
            uri="resource://ymcp/memory-protocol",
            name="ymcp_memory_protocol",
            title="Ymcp Memory Protocol",
            description="记忆核验、写入、更新、失效和安全规则。",
            mime_type="text/markdown",
            content=_memory_protocol_content(),
        ),
        ResourceSpec(
            uri="resource://ymcp/project-rule-template",
            name="ymcp_project_rule_template",
            title="Ymcp Project Rule Template",
            description="Trae / LLM 宿主项目规则模板。",
            mime_type="text/markdown",
            content=TRAE_PROJECT_RULE_TEMPLATE,
        ),
        ResourceSpec(
            uri="resource://ymcp/host-integration",
            name="ymcp_host_integration",
            title="Ymcp Host Integration",
            description="宿主集成说明和 MCP-first 使用约束。",
            mime_type="text/markdown",
            content=HOST_INTEGRATION_CONTENT,
        ),
    )


PROMPT_SPECS: tuple[PromptSpec, ...] = (
    PromptSpec("deep_interview_clarify", "Deep Interview Clarify", "启动需求澄清的可复用调用模板。", ("brief",)),
    PromptSpec("plan_direct", "Plan Direct", "明确任务的直接计划模板。", ("task",)),
    PromptSpec("ralplan_consensus", "Ralplan Consensus", "高风险/架构型共识规划模板。", ("task",)),
    PromptSpec("ralph_verify", "Ralph Verify", "执行后证据判断和继续/修复/完成决策模板。", ("approved_plan", "latest_evidence")),
    PromptSpec("memory_store_after_completion", "Memory Store After Completion", "任务结束后沉淀长期记忆模板。", ("summary",)),
)


def get_prompt_specs() -> tuple[PromptSpec, ...]:
    return PROMPT_SPECS


def prompt_template(name: str, **kwargs: Any) -> str:
    if name == "deep_interview_clarify":
        brief = kwargs.get("brief") or "{brief}"
        return f"""请使用 Ymcp 的 `deep_interview` 工具澄清需求：

brief: {brief}

规则：先读取 `resource://ymcp/principles`；如涉及历史项目事实，先调用 `memory_search` 并把结果作为 memory_context。不要伪造用户回答；需要继续提问时使用工具返回的 next_question 或 MCP Elicitation。需求结晶后必须根据 `handoff_options` 展示结构化下一步菜单；在 `selected_next_tool` 缺失前不得自动调用 plan、ralplan 或 ralph，也不要用普通结束文案替代菜单。"""
    if name == "plan_direct":
        task = kwargs.get("task") or "{task}"
        return f"""请使用 Ymcp 的 `plan` 工具生成直接计划：

task: {task}
mode: direct

要求：计划只产生结构化结果，不执行文件修改；如工具返回 requested_input，优先使用 MCP Elicitation 或按 needs_input 降级结果向用户索取缺失信息。"""
    if name == "ralplan_consensus":
        task = kwargs.get("task") or "{task}"
        return f"""请使用 Ymcp 的 `ralplan` 工具推进共识规划：

task: {task}
current_phase: planner_draft

流程：planner_draft → architect_review → critic_review。每轮只把真实评审结论传回工具；批准后再让用户选择 ralph / plan / memory_store。"""
    if name == "ralph_verify":
        approved_plan = kwargs.get("approved_plan") or "{approved_plan}"
        latest_evidence = kwargs.get("latest_evidence") or "{latest_evidence}"
        return f"""请使用 Ymcp 的 `ralph` 工具判断执行状态：

approved_plan: {approved_plan}
latest_evidence: {latest_evidence}

规则：只依据真实证据判断 complete / needs_more_evidence / needs_verification_plan；不要伪造测试或执行结果。"""
    if name == "memory_store_after_completion":
        summary = kwargs.get("summary") or "{summary}"
        return f"""任务完成后，请先用 `memory_search` 或 `memory_check_duplicate` 查重，再按需调用 `memory_store` 保存长期记忆：

summary: {summary}

只保存稳定偏好、项目约定、重要决策和可复用踩坑结论；不要保存密钥、隐私或未经确认的敏感信息。"""
    raise KeyError(f"unknown prompt template: {name}")

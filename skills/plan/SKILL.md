---
name: plan
description: Strategic planning with planner, architect, and critic stages
---

# Plan

## Purpose
`$plan` is the planning workflow that sits between requirement clarification and execution.

In Ymcp:
- user-facing skill: `$plan`
- actual MCP entry tool: `yplan`
- unified handoff tool: `menu`
- planner / architect / critic are thinking roles inside this skill, not public MCP stage tools

## Workflow model
Ymcp planning is a lightweight skill-flow:
1. `yplan` returns planner `skill_content`.
2. The model completes planner / architect / critic reasoning in the same skill flow.
3. The model outputs a visible planning summary containing requirements, accepted plan, tradeoffs, risks, and verification approach.
4. The model calls `menu` with:
   - `source_workflow="yplan"`
   - `summary=<planning summary>`
   - `options=[ydo, yplan, memory_store]`
5. `menu` handles MCP Elicitation first and falls back to WebUI when Elicitation fails.

## When to use
- The task is clear enough to plan, but not yet ready to execute
- You want planner / architect / critic perspectives before `ydo`
- You want a structured plan artifact for downstream execution

## Stage roles
- **Planner** drafts the initial plan
- **Architect** challenges feasibility, boundaries, and tradeoffs
- **Critic** judges readiness and either approves handoff or recommends another `yplan` pass

## Core rules
- Do not invent a separate routing protocol inside the skill.
- Do not call `yplan_architect`, `yplan_critic`, or `yplan_menu`; they are no longer public workflow tools.
- Complete planner / architect / critic reasoning before calling `menu`.
- If the critic concludes that the plan is not ready, call `menu` with `yplan` as a legal option and explain the replan reason in `summary`.
- If the plan is ready, call `menu` with `ydo` as the recommended option.
- The host must render a real interactive control from `handoff.options` as the only next-step menu source.
- If MCP Elicitation is unavailable or fails, `menu` provides a WebUI fallback; do not render a markdown/text menu as assistant output.

## Expected plan contents
- Requirements summary
- Acceptance criteria
- Implementation outline
- Risks and mitigations
- Verification approach

## Planning Complete
When the critic decides the plan is ready, planning pauses at `menu`.

Interpret that boundary correctly:
- critic approval itself is not the end of the interaction
- `menu` is a handoff-only workflow-menu tool
- it does not continue analysis or auto-start execution

After `menu` returns:
- treat `handoff.options` as the only authoritative next-step menu
- preserve all returned options and recommendation markers
- do not omit, rewrite, merge, reorder, invent, or auto-select options
- if Elicitation fails, use the returned WebUI fallback instead of a text menu

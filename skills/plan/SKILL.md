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
- stage tools: `yplan_architect`, `yplan_critic`
- completion tool: `yplan_complete`

## Workflow model
Ymcp planning is a lightweight skill-flow:
1. `yplan` returns planner `skill_content`
2. the model completes the planner stage and calls `yplan_architect`
3. `yplan_architect` returns architect `skill_content`
4. the model completes the architect stage and calls `yplan_critic`
5. `yplan_critic` returns critic `skill_content` plus the only two legal next steps:
   - `yplan`
   - `yplan_complete`
6. the model either restarts planning at `yplan` or closes planning with `yplan_complete`
7. `yplan_complete` closes the planning phase and returns the next workflow options

The tool defines stage boundaries and legal next steps. The skill defines how to think during each stage.

Ymcp does not require the model to round-trip a mid-plan state object between `yplan`, `yplan_architect`, and `yplan_critic`. Within the same call chain, the model carries that context itself.

## When to use
- The task is clear enough to plan, but not yet ready to execute
- You want planner / architect / critic perspectives before `ydo`
- You want a structured plan artifact for downstream execution

## Stage roles
- **Planner / `yplan`** drafts the initial plan
- **Architect / `yplan_architect`** challenges feasibility, boundaries, and tradeoffs
- **Critic / `yplan_critic`** judges readiness and either approves completion or restarts planning at `yplan`

## Core rules
- Do not invent a separate routing protocol inside the skill.
- Follow the tool-returned next-step boundary at each phase.
- In `yplan_critic`, decide between `yplan` and `yplan_complete` from the returned options.
- If the critic concludes that the plan is not ready, restart planning at `yplan`.
- If the plan is rejected, you must restart planning at `yplan`.
- Do not continue inside `yplan_critic` after rejection.
- Do not route rejection back to `yplan_architect`.
- `yplan_complete` closes the planning phase, not the overall task.
- Do not say the task is complete; only the planning phase is complete.
- Do not treat `yplan_complete` as a final analysis, final report, or execution step.
- When `yplan_critic` approves the plan, do not end the conversation at the approval text; you must continue by calling `yplan_complete`.
- Do not invent a mandatory pre-complete summary protocol. If you choose to emit an approval summary before `yplan_complete`, keep it brief and treat it as a handoff note rather than the final answer.
- The host must present every menu option from `handoff.options` as the only next-step menu source.
- If `handoff.options` is present, stop planning and use those options verbatim instead of paraphrasing, merging, or auto-selecting.

## Expected plan contents
- Requirements summary
- Acceptance criteria
- Implementation outline
- Risks and mitigations
- Verification approach

## Planning Complete

When `yplan_critic` decides the plan is ready, the flow ends with `yplan_complete`.

Interpret that boundary correctly:
- the critic approval itself is not the end of the interaction
- `yplan_complete` is a handoff-only closeout tool.
- It does not continue analysis.
- It does not generate the final business conclusion.
- It does not auto-start execution.

After `yplan_complete` returns:
- treat `handoff.options` as the only authoritative next-step menu
- preserve all returned options
- preserve recommendation markers
- do not omit, rewrite, merge, reorder, invent, or auto-select options
- if host-side elicitation is unavailable, report that limitation and still display the returned menu faithfully

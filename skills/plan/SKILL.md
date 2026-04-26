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

## Design model
Ymcp planning is a lightweight skill-flow:
1. `yplan` returns planner `skill_content`
2. the model completes the planner stage and calls `yplan_architect`
3. `yplan_architect` returns architect `skill_content`
4. the model completes the architect stage and calls `yplan_critic`
5. `yplan_critic` returns critic `skill_content` plus the only two legal next steps:
   - `yplan_critic`
   - `yplan_complete`
6. the model decides whether to keep refining or to complete planning
7. `yplan_complete` is a no-input completion gate that closes the planning phase and returns the next workflow options

The tool is responsible for stage boundaries and legal next steps.  
The skill is responsible for how to think during the current stage.

Ymcp does not require the model to round-trip a mid-plan state object between `yplan`, `yplan_architect`, and `yplan_critic`. Within the same call chain, the model carries that context itself.

## When to use
- The task is clear enough to plan, but not yet ready to execute
- You want planner / architect / critic perspectives before `ydo`
- You want a structured plan artifact for downstream execution

## Stage reasoning shape
- **Planner / `yplan`** drafts the initial plan
- **Architect / `yplan_architect`** challenges boundaries and feasibility
- **Critic / `yplan_critic`** judges readiness and decides whether to continue iterating or complete

## Important rule
Do not invent a separate routing protocol inside the skill.  
Follow the tool-returned next-step boundary at each phase. In `yplan_critic`, do not rely on a fixed `APPROVE/REVISE` schema; decide whether the plan is ready and choose between `yplan_critic` and `yplan_complete` from the returned options.

## Typical outputs
- Requirements summary
- Acceptance criteria
- Implementation outline
- Risks and mitigations
- Verification approach

## Completion-stage handoff rules

When planning reaches the `yplan_complete` stage, the model is no longer drafting or debating the plan. It is only closing the planning phase and handing off.

### Allowed at `yplan_complete`
- Summarize the approved plan briefly
- Point to the returned `handoff.options`
- Recommend `ydo` when execution should begin
- Treat the act of calling `yplan_complete` itself as the signal that planning is done; do not expect the tool to validate a summary payload

### Forbidden at `yplan_complete`
- Do not restate the full business analysis
- Do not reopen requirements discovery or design debate
- Do not ask "should I start execution?" when `ydo` is already the recommended option
- Do not say the task is complete; only the planning phase is complete

### Recommended output shape for `yplan_complete`
```md
# Planning Complete

## Approved Plan Summary
- Goal: <one sentence>
- Chosen approach: <one sentence>
- Key constraints: <1-3 bullets>
- Acceptance criteria: <1-3 bullets>

## Next Step
Use the returned `handoff.options` to choose the next action.

**Recommended:** `ydo`

## Important
- The plan is complete
- The overall task is not complete yet
- Execution should continue through the workflow options, not by inventing a new branch
```

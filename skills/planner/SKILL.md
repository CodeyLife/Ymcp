---
name: planner
description: Pure MCP host planning perspective for creating actionable work plans
---

# Planner Perspective Skill

## Purpose
Use this role when a pure MCP host needs to draft or revise an execution-ready work plan without relying on subagents or Codex-only tools.

In Ymcp terminology:
- this file is the **planner thinking skill**
- the MCP workflow entry tool that usually delivers this skill is `yplan`
- `yplan` is a workflow tool name, while `planner` is the phase/prompt name

## MCP Host Assumptions
- Do not assume special question APIs, Planner subagents, or shell/search helpers are exposed by the MCP server.
- Ask user preferences in normal chat, one focused question at a time.
- Use available host-native inspection tools when present.
- Prefer Ymcp resources/prompts and `mempalace_*` tools before asking about discoverable facts.
- If no file-write capability exists, keep the plan in the conversation and label it as the current plan.

## Steps
1. Restate the task, desired outcome, constraints, and known evidence.
2. Gather missing codebase/project facts using available host tools and Ymcp resources / `mempalace_*` tools.
3. Draft a plan with requirements summary, testable acceptance criteria, right-sized implementation steps, risks, and verification steps.
4. For consensus planning, include RALPLAN-DR principles, decision drivers, viable options, and alternative invalidation rationale when needed.
5. In deliberate mode, add a pre-mortem and expanded test plan covering unit, integration, e2e, and observability.
6. If file-write capability is available, save under `.omx/plans/`; otherwise keep the plan in the conversation output.

## Output Contract
- Requirements Summary
- Acceptance Criteria
- Implementation Steps
- Risks and Mitigations
- Verification Steps
- RALPLAN-DR Summary when in consensus mode
- ADR when a final decision is chosen
- Ralph MCP handoff guidance: approved plan artifact or equivalent structured summary, constraints to preserve, and expected verification evidence

## Verification
Before handing off, verify that the plan is specific, testable, grounded in available evidence, and does not claim that unavailable subagents or tools were used.

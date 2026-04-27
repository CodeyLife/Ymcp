---
name: critic
description: Critic perspective for validating plan quality and readiness
---

# Critic Perspective Skill

## Purpose
Use this role to judge whether the current plan is clear, complete, testable, and safe enough for execution handoff.

## Key rule
This skill is for evaluation, not custom routing. Judge readiness, then choose the next step only from the tool-returned `handoff.options`.

## What to inspect
1. Can execution proceed without guessing?
2. Are acceptance criteria concrete and testable?
3. Are scope, constraints, risks, and rollback/fallback covered?
4. Are verification steps specific enough to prove completion?
5. For consensus planning, are alternatives explored fairly and is the chosen path justified?

## Output contract
- Justification
- Clarity
- Testability
- Completeness
- Risk / Verification Rigor
- Required Changes
- Evidence Gaps

## Decision rule
- If you judge the plan as ready, you must do the approved path in this order:
  1. make approval explicit
  2. explain briefly why execution can proceed now
  3. preserve any critical constraints or risks worth carrying forward
  4. call `yplan_complete` from `handoff.options` as a handoff-only closeout step, passing `critic_summary`
- If the plan is not ready, make rejection explicit, name the blockers, identify the highest-priority fixes for the next planning pass, and choose `yplan` from the returned `handoff.options`.

## Guardrails
- Do not invent a separate routing protocol.
- Do not keep revising inside `yplan_critic` after rejection.
- Do not bypass the tool-returned next-step options.
- Do not call `yplan_complete` with only `schema_version` or otherwise empty planning context; pass `critic_summary`.
- Do not stop the conversation right after writing the approval conclusion; approval is only the precondition for calling `yplan_complete`, not the terminal step.
- Do not treat `yplan_complete` as the step that writes the final analysis or final user-facing conclusion.
- Once `handoff.options` is returned, do not render a markdown/text menu as assistant output and do not auto-advance; only host UI or an explicit selected_option may continue.

## Verification
Never approve a vague plan. If evidence is missing, say so explicitly instead of guessing.

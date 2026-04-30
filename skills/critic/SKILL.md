---
name: critic
description: Critic perspective for validating plan quality and readiness
---

# Critic Perspective Skill

## Purpose
Use this role to judge whether the current plan is clear, complete, testable, and safe enough for execution handoff.

## Key rule
This skill is for evaluation, not custom routing. Judge readiness, then hand off through unified `menu` only after a visible summary exists.

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
- If you judge the plan as ready, make approval explicit, explain why execution can proceed, preserve critical constraints, then call unified `menu` with `source_workflow="yplan"` and options that include `ydo`.
- If the plan is not ready, make rejection explicit, name blockers, identify fixes for the next planning pass, then call unified `menu` with `source_workflow="yplan"` and `yplan` as a legal option.

## Guardrails
- Do not invent a separate routing protocol.
- Do not bypass `menu` for next-step selection.
- Do not stop the conversation right after writing the approval conclusion; approval is only the precondition for calling `menu`, not the terminal step.
- Once `handoff.options` is returned, do not render a markdown/text menu as assistant output and do not auto-advance; only host UI, WebUI fallback, or an explicit selected_option may continue.

## Verification
Never approve a vague plan. If evidence is missing, say so explicitly instead of guessing.

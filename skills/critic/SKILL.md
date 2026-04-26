---
name: critic
description: Critic perspective for validating plan quality and readiness
---

# Critic Perspective Skill

## Purpose
Use this role to judge whether the current plan is clear, complete, testable, and safe enough for execution handoff.

## Key rule
This skill is for **evaluation**, not routing. After judging the plan, choose the next step from the tool's returned `handoff.options`. Do not invent a separate routing protocol or a required verdict schema.

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

## Next-step rule
- If the plan is strong enough to proceed, select the completion path from `handoff.options`
- If the plan requires more work, select the continued-critic path from `handoff.options`
- Always treat the tool-returned options as the source of truth for what can happen next

## Verification
Never approve a vague plan. If evidence is missing, say so explicitly instead of guessing.

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
- If the plan requires more work, select the restart-planning path from `handoff.options`
- Always treat the tool-returned options as the source of truth for what can happen next

## Approved-path hard rule
If you judge the plan as ready, you must do the approved path in this order:
1. make the approval decision explicit
2. choose `yplan_complete` from the returned `handoff.options`
3. let `yplan_complete` hand off the legal next-step menu

Do not invent a mandatory natural-language pre-complete summary protocol.
Do not replace the approval decision with a bare verdict such as "approved" or "looks good" when a short rationale would help, but do not block on a required summary either.
Do not ask the user an open-ended next-step question before `yplan_complete`; the next-step boundary still comes from `handoff.options`.

### Minimum approval shape
- Approval statement
- Why the plan is executable now
- Any key constraints or risks that must survive execution, if they are important enough to mention
- Recognition that the next step must come from the tool-returned `handoff.options`

## Reject-path hard rule
If you judge the plan as not ready, you must do the reject path in this order:
1. make the rejection decision explicit
2. identify the gaps that block execution handoff
3. choose `yplan` from the returned `handoff.options`
4. let `yplan` restart planning from a fresh task brief

Do not continue looping inside `yplan_critic` after rejection.
Do not route rejection back to `yplan_architect`.
Do not treat critic as the stage that rewrites the plan after a failed review; rejection means the planning workflow restarts at `yplan`.

### Minimum rejection shape
- Rejection statement
- Why the plan is not executable yet
- The highest-priority fixes that the next `yplan` run must address
- Recognition that the next step must come from the tool-returned `handoff.options`

## Verification
Never approve a vague plan. If evidence is missing, say so explicitly instead of guessing.

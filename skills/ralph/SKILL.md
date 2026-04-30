---
name: ralph
description: Persistent execution and verification loop for finishing a task
---

# Ralph

> Boundary note: in Ymcp, the `ralph` skill corresponds to the `ydo` tool. The tool does not execute the whole loop for the model; it returns the execution prompt plus the next-step options, and the host/model continue from there.

## Purpose
Ralph is the execution phase. Its job is to finish the task, verify it with fresh evidence, and only then allow the workflow to close.

## Use when
- The task already has a clear execution target
- Planning is done and you want to implement / fix / verify
- The user wants persistence until the task is actually complete

## Do not use when
- The task is still ambiguous
- Scope and non-goals are still unclear
- You still need a planning pass before execution

## Core loop
1. Read the approved plan or execution brief.
2. Implement / fix / verify.
3. Gather fresh evidence.
4. Output an execution / verification summary.
5. Call unified `menu` with `source_workflow="ydo"` and options `finish`, `memory_store`, `yplan`, `continue_execution`.
6. Choose the next step from `handoff.options`.

Within the same execution call chain, do not invent or depend on a mid-execution artifact round-trip unless the tool explicitly asks for one.
`ydo` now starts without a business payload, and unified `menu` is the workflow menu gate.

## Minimal response shape
For `ydo`, the response may include:
- goal
- approved plan or brief reference
- key constraints to preserve
- expected verification evidence

For the `menu.summary` after `ydo`, the response may include:
- what changed
- what evidence proves it
- remaining blockers or follow-up needs

## Verification standard
- Prefer real test / build / lint / diagnostic evidence.
- Do not claim completion based on guesses.
- If verification fails, continue fixing instead of stopping early.

# Execution Start

At `ydo`, begin from the current approved plan or execution brief, preserve the active constraints, and aim to produce fresh verification evidence before attempting to close the loop.

## Next-step rule
After a Ralph iteration, do not invent your own routing rules. Call `menu` with these options:
- `finish`
- `memory_store`
- `yplan`
- `continue_execution`

# Execution Complete

Unified `menu` is a handoff gate, not a substitute for verification. Use it only after a real execution pass, and interpret its returned menu as the only authoritative source for how the workflow should continue.

## Guardrails
- Do not reopen planning unless execution reveals a real blocker or mismatch.
- Do not recommend `finish` without fresh verification evidence.
- Do not recommend `finish` if failures remain or verification is incomplete.
- Do not invent routing outside `handoff.options`.

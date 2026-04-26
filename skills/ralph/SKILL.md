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

## Core behavior
1. Read the approved plan or execution brief
2. Implement / fix / verify
3. Gather fresh evidence
4. Call `ydo_complete`
5. Choose the next step from `handoff.options`

Within the same execution call chain, do not invent or depend on a mid-execution artifact round-trip unless the tool explicitly asks for one.
`ydo` now starts without a business payload, and `ydo_complete` is a no-input completion gate.

## Execution-stage output templates

### Recommended output shape for `ydo`
```md
# Execution Start

## Execution Brief
- Goal: <one sentence>
- Approved plan: <one sentence>
- Constraints to preserve: <1-3 bullets>
- Verification expectation: <1-3 bullets>

## Next Step
Complete the implementation / fix / verification work, then call `ydo_complete`.

**Recommended:** `ydo_complete`

## Important
- This stage starts execution
- Do not reopen planning unless a real blocker or mismatch appears
- Do not stop at partial progress and call it done
```

### Recommended output shape for `ydo_complete`
```md
# Execution Complete

## Execution Summary
- Implemented: <1-3 bullets>
- Verified with: <tests / build / lint / diagnostics>
- Remaining issues: <or none>

## Next Step
Use the returned `handoff.options` to choose how to close or continue.

**Recommended:** `finish`

## Important
- Only this stage may recommend workflow completion
- Do not recommend `finish` if failures remain or verification is incomplete
- Use `yplan` only for real replanning
- Use `continue_execution` when more implementation or verification is still needed
```

## Verification standard
- Prefer real test / build / lint / diagnostic evidence
- Do not claim completion based on guesses
- If verification fails, continue fixing instead of stopping early

## Output expectations
- What changed
- What evidence proves it
- What, if anything, is still blocked

## Next-step rule
After finishing a Ralph iteration, do **not** invent your own routing rules. Use the tool-returned options:
- `finish`
- `memory_store`
- `yplan`
- `continue_execution`

## Notes
- `yplan` means “go back to planning because execution revealed new needs”
- `continue_execution` means “stay in the current execution loop and keep working”

## Hard constraints
- Do not ask for permission to proceed when the workflow already has a recommended next option
- Do not collapse execution completion into workflow completion unless `finish` is actually the correct next step
- Do not invent routing outside `handoff.options`

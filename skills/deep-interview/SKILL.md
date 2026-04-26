---
name: deep-interview
description: Intent-first clarification before planning or execution
argument-hint: "<idea or vague request>"
---

# Deep Interview

## Purpose
Use deep-interview when the request is still vague and the model needs to clarify intent, scope, and success criteria before planning or execution.

In Ymcp:
- skill command seen by the model/user: `$deep-interview`
- actual MCP tool name returned by the server: `ydeep`
- completion tool: `ydeep_complete`

## Design model
Ymcp uses a lightweight skill-flow:
1. `ydeep` returns `skill_content`
2. the model performs clarification using the skill guidance and outputs the result
3. the host calls `ydeep_complete`
4. `ydeep_complete` returns `clarified_artifact` plus the next-step options
5. the user/model chooses the next step through Elicitation or equivalent host UI

The tool provides phase boundaries and legal next steps.  
The skill provides the thinking method for the current phase.

## What to clarify
- Why the user wants the change
- What outcome they want
- What is in scope
- What is explicitly out of scope
- What constraints or success criteria must hold

## Use when
- The request is broad or ambiguous
- Acceptance criteria are still unclear
- The user wants the model to ask clarifying questions first

## Do not use when
- The task is already clear enough to plan
- A plan already exists and execution should begin

## Next-step rule
After clarification, use the returned options as the only legal next steps:
- `yplan`
- `refine_further`

Do not invent a direct execution jump unless the tool explicitly offers it.

## Completion-stage output template
```md
# Clarification Complete

## Clarified Summary
- Goal: <one sentence>
- Scope: <one sentence>
- Constraints: <1-3 bullets>

## Next Step
Use the returned `handoff.options` to choose the next action.

**Recommended:** `yplan`

## Important
- Clarification is complete
- The overall task is not complete
- Do not jump to a new workflow until `ydeep_complete` has been called
```

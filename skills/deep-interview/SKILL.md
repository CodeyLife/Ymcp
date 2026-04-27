---
name: deep-interview
description: Intent-first clarification before planning or execution
argument-hint: "<brief>"
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
2. the model performs clarification using the skill guidance
3. the host calls `ydeep_complete`
4. `ydeep_complete` returns the clarified artifact plus the legal next-step options

The skill governs the clarification method. The tool/host govern completion and next-step selection.

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

## Optional completion note
May include:
- clarified goal
- scope
- constraints
- a reminder that the next action must come from `handoff.options`

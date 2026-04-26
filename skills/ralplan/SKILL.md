---
name: ralplan
description: Alias for $plan --consensus
---

# Ralplan

`$ralplan` is the consensus-planning alias for `$plan`.

## What it means in Ymcp
- User-facing skill name: `$ralplan`
- Actual MCP workflow entry: `yplan`
- Thinking shape: `planner -> architect -> critic`

## Host model
Ymcp is a lightweight skill-flow:
- the tool returns `skill_content`
- the model completes the current stage
- the host shows the returned options / Elicitation choices
- the next stage is chosen from `handoff.options`

Ymcp does **not** try to auto-route the whole workflow through a heavy protocol.

## When to use
- The task needs a real planning pass before execution
- You want planner / architect / critic perspectives before entering `ydo`

## Practical rule
Use the main `$plan` documentation for the detailed planning method. Use this alias when the intent is specifically “run the consensus planning flow”.

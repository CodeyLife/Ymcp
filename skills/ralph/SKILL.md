---
name: ralph
description: Persistent execution and verification loop for finishing a task; adapted to Ymcp ydo/menu with restored verification pressure
---

# Ralph

> Boundary note: in Ymcp, the `ralph` skill corresponds to the `ydo` tool. The tool does not execute the whole loop for the model; it returns the execution prompt plus the next-step options, and the host/model continue from there.

## Purpose

Ralph is the execution phase. Its job is to finish the task, verify it with fresh evidence, and only then allow the workflow to close.

参考原工作流，Ralph 的核心不是“尽力做一下”，而是持续推进到满足验收标准：先执行，再验证，再修复，再复验；不能用主观判断代替证据。

## Use when

- The task already has a clear execution target
- Planning is done and you want to implement / fix / verify
- The user wants persistence until the task is actually complete
- `yplan` 已经给出可执行计划、验收标准和验证路径

## Do not use when

- The task is still ambiguous
- Scope and non-goals are still unclear
- You still need a planning pass before execution
- 缺少任何可验证完成标准

## Ymcp execution model

1. `ydo()` 返回 `ralph` skill guidance。
2. 模型从当前调用链上下文中的批准计划/执行 brief 继续。
3. 模型实现、修复、验证，并输出可见执行总结。
4. 模型调用统一 `menu`：
   - `source_workflow="ydo"`
   - `summary=<执行与验证总结>`
   - `options=[finish, memory_store, yplan, continue_execution]`
5. `menu` 的 `handoff.options` 是下一步唯一权威来源。

`ydo` 当前不要求业务 payload，也不维护重型服务端循环状态；持久循环由模型/宿主按本 skill 执行。

## Core loop

1. Read the approved plan or execution brief.
2. Build or refresh a concise task ledger: requirements, non-goals, constraints, files touched, verification commands.
3. Implement / fix / verify.
4. Gather fresh evidence.
5. If verification fails, fix and rerun verification; do not stop at partial progress.
6. Output an execution / verification summary.
7. Call unified `menu` with `source_workflow="ydo"` and options `finish`, `memory_store`, `yplan`, `continue_execution`.
8. Choose the next step only from `handoff.options`.

Within the same execution call chain, do not invent or depend on a mid-execution artifact round-trip unless the tool explicitly asks for one.

## Restored execution pressure from reference workflow

### Pre-context intake

Before meaningful execution, assemble or reuse a grounding snapshot in conversation or files: task statement, desired outcome, known facts/evidence, constraints, unknowns/open questions, likely codebase touchpoints, approved plan or acceptance criteria. If ambiguity is still high, do not improvise execution. Return to `yplan` or `ydeep` through the workflow menu.

### Parallelism

Use parallel work only when tasks are genuinely independent and the current environment supports safe subagents. Do not wait sequentially on independent lanes when parallel verification or inspection would materially improve throughput. In Ymcp docs this is a model/host behavior, not a server guarantee.

### Background operations

Long operations may be run in the background when the host supports it: package installs, builds, test suites, docker operations. Foreground/blocking is preferred for quick status checks, file reads, edits, and short diagnostics.

### Visual task gate

For screenshot/reference-image tasks, use a structured visual verdict before the next edit when such a verifier is available. Treat visual score, differences, suggestions, and reasoning as verification evidence. In Ymcp core this is advisory unless the host exposes a visual-verdict tool.

### Cleanup / deslop pass

After verification passes, review changed files for avoidable slop: delete unnecessary code, reuse existing utilities, avoid new abstractions without need, preserve behavior, and rerun regression verification after cleanup. If a user explicitly opts out of cleanup, keep the latest successful verification evidence and record the skipped cleanup risk.

## Verification standard

- Prefer real test / build / lint / diagnostic evidence.
- Read the command output and confirm it actually passed.
- Do not claim completion based on guesses.
- If verification fails, continue fixing instead of stopping early.
- Check that no pending TODO/task remains in the current scope.
- For larger or risky changes, get an independent review when possible.

## Minimal response shape

For `ydo`, the response may include:
- goal
- approved plan or brief reference
- key constraints to preserve
- expected verification evidence

For the `menu.summary` after `ydo`, the response should include:
- what changed
- what evidence proves it
- remaining blockers or follow-up needs
- whether `finish`, `memory_store`, `yplan`, or `continue_execution` is recommended and why

# Execution Start

At `ydo`, begin from the current approved plan or execution brief, preserve the active constraints, and aim to produce fresh verification evidence before attempting to close the loop.

If the current context does not contain a sufficient plan, do not fabricate one. Use `menu` to route back to `yplan` or continue clarification.

## Next-step rule

After a Ralph iteration, do not invent your own routing rules. Call `menu` with these options:
- `finish`
- `memory_store`
- `yplan`
- `continue_execution`

# Execution Complete

Unified `menu` is a handoff gate, not a substitute for verification. Use it only after a real execution pass, and interpret its returned menu as the only authoritative source for how the workflow should continue.

## Stop / continue conditions

Continue when verification failed, required tests/build/lint were not run, acceptance criteria are only partially met, a recoverable blocker exists, or cleanup/regression found issues.

Only recommend `finish` when requirements are met, fresh verification evidence exists, no known relevant errors remain, no pending in-scope tasks remain, and remaining risks are explicitly listed.

## Guardrails

- Do not reopen planning unless execution reveals a real blocker or mismatch.
- Do not recommend `finish` without fresh verification evidence.
- Do not recommend `finish` if failures remain or verification is incomplete.
- Do not invent routing outside `handoff.options`.
- Do not delete or weaken tests just to pass verification.
- Do not reduce scope silently.

## 与原参考工作流的保留/适配差异

保留：持久执行压力、新鲜验证证据、并行独立任务、长任务后台化、架构/独立复核、cleanup/deslop 后回归验证、PRD/上下文快照思路、视觉任务 gate。

适配：上述能力在当前项目中作为执行方法和宿主可选增强；公共 MCP 交接通过 `ydo` + `menu` 完成。

## Optional PRD-style execution

如果当前上下文包含 PRD/用户故事，可把它们作为 task ledger：story id / title、acceptance criteria、priority、pass/fail status、verification evidence。如宿主支持文件，可使用 `.omx/plans/prd-{slug}.md` 与 `.omx/state/{scope}/ralph-progress.json`；否则在对话摘要中维护等价信息。不要声称 Ymcp 服务端已自动创建这些文件。

## Final checklist

- [ ] Requirements from the current task/plan are met
- [ ] Non-goals and constraints preserved
- [ ] Fresh verification evidence collected and read
- [ ] Build/test/typecheck/lint/static diagnostics run where relevant
- [ ] Changed files reviewed for unnecessary complexity
- [ ] Regression verification after cleanup completed where relevant
- [ ] Known risks and not-tested gaps listed
- [ ] `menu` called with `source_workflow="ydo"`

# Goal

## Objective

将当前小说创作模块实现为适合数千章节、单作者使用的可靠长篇创作系统：严格隔离创作契约、叙事事实、角色认知与候选态，建立可追溯的事实断言和正文修订、分层整合且非破坏性淘汰的长期记忆、按时点和视角隔离且可解释的 LLM 上下文，以及字段级和逐段可审阅的修改流程；保留现有用户改动和可用功能，以测试、类型检查、构建及关键用户流程证明完成。

## Success Signals

- [x] [intent-preserved] (satisfied) The refined goal brief preserves the user's stated intent and boundaries.
- [x] [evidence-reviewed] (satisfied) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [x] [no-open-required-work] (satisfied) No known required work remains for the refined goal brief.
- [x] [novel-system-implemented] (satisfied) The novel studio implements the agreed truth, memory, context, review, and durability architecture for a single author, with verified long-form workflows.

## Current Strategy

Implement the agreed architecture in dependency order, starting with workflow integrity and provenance, while preserving the live worktree and proving each loop with focused tests before broad verification.

## Next Loop Direction

Audit completion evidence.
Progress signal estimate: 100%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

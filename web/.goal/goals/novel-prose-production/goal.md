# Goal

## Objective

将 Ymcp/web 小说创作板块的正文生成工作流优化为可实际支撑原创长篇生产的系统：基于现有架构梳理创作上下文与提示词链路，建立具有明确场景、人物欲望与选择、叙事张力、自然对白、语言节奏、意象回响和跨章延展性的原创写作约束；用固定代表性样例进行真实 LLM 生成，以结构化文学质量审核识别机械报表式事实陈述并持续迭代；保留现有用户改动和功能，以生成样本、审核结果、自动化测试、类型检查与构建证据证明达到生产门槛。

## Success Signals

- [x] [intent-preserved] (satisfied) The refined goal brief preserves the user's stated intent and boundaries.
- [x] [evidence-reviewed] (satisfied) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [x] [no-open-required-work] (satisfied) No known required work remains for the refined goal brief.
- [x] [prose-production-quality] (satisfied) Representative original chapter samples produced by the real workflow achieve at least 4.0/5 in an independent LLM literary audit, with no blocker and no core dimension below 3.5.
- [x] [anti-mechanical-prose] (satisfied) Generated samples are scene-led rather than report-like: character desire, consequential choice, subtext, sensory embodiment, sentence rhythm, and chapter-end drive are evidenced while summary-like exposition and template phrasing stay below defined gates.
- [x] [workflow-quality-loop] (satisfied) The production workflow applies layered drafting constraints and a prose-focused review rubric, preserves long-form context boundaries, and can use review findings for another bounded iteration without corrupting approved facts or prose.
- [x] [engineering-verification] (satisfied) Focused prompt and quality regression tests, the relevant novel test suite, TypeScript checking, and production build all pass after the changes.

## Current Strategy

Use fixed original story briefs to compare real generated prose before and after narrowly changing the drafting contract and literary audit rubric; prefer a small hierarchy of high-impact narrative obligations over a long flat prompt checklist.

## Next Loop Direction

Audit completion evidence.
Progress signal estimate: 100%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

# Goal

## Objective

查询并总结优秀网文（雪中悍刀行、剑来、我在风花雪月里等你等）写作技巧，基于总结优化 novel 模块参考 skill 与审核机制，再通过完整工作流生成任一主题小说章节，用 LLM 分析每步产物并迭代循环改进，最终产出带文学质感的高质量中文小说正文。

## Success Signals

- [x] [intent-preserved] (satisfied) The refined goal brief preserves the user's stated intent and boundaries.
- [x] [evidence-reviewed] (satisfied) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [x] [no-open-required-work] (satisfied) No known required work remains for the refined goal brief.
- [x] [writing-technique-summary] (satisfied) 完成至少 3 部优秀网文（雪中悍刀行/剑来/我在风花雪月里等你）写作技巧总结，归档到 findings.md，覆盖人物/叙事/文笔/感情线/节奏多维度。
- [x] [skill-prompt-optimized] (satisfied) 至少 2 个 builtin novel skill 的 prompt 基于技巧总结得到落地优化，且 tsc --noEmit 通过。
- [x] [review-mechanism-enhanced] (satisfied) 审核机制（quality.ts/review-stage/prose-prompts 至少一处）基于总结得到增强，含可执行检查项。
- [x] [full-workflow-e2e] (satisfied) 通过完整工作流（context→blueprint→draft→review→revision→commit）生成至少一章小说正文，章节数≥1，字数符合 DEFAULT_CHAPTER_TARGET_WORDS。
- [x] [llm-analysis-iteration] (satisfied) 至少 2 轮 LLM 对工作流产物进行文学/质量分析并基于反馈迭代改进（含前后对比）。

## Current Strategy

Refine the broad goal only enough to choose the next evidence-seeking loop; avoid pre-building a task list.

## Next Loop Direction

目标完成——novel 模块的 skill 与审核机制已基于雪中/剑来/庆余年/将夜/风花雪月 5 部作品的写作技巧总结得到落地增强，并通过真实 LLM 完整工作流生成 + 2 轮 LLM 分析迭代验证了产出高质量中文小说的能力（v2 平均 4.13，无 blocker/major）。所有 8 个 success signal 均已 satisfied 且有 verified artifact 证据溯源。残留 7 个 minor 为可选优化方向，不阻塞 completion。
Progress signal estimate: 100%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

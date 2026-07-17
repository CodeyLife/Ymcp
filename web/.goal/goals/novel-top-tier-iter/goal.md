# Goal

## Objective

通过测试分析产出文章内容，迭代优化小说创作模块（单章 prose / 多章节结构 / 工作流环节 context/blueprint/draft/review/revision/fact 任一）的提示词或流程，目标是产出文章在多场景稳定通过顶尖网络小说水平判据。迭代视角覆盖 prose/structure/voice/hooks/imagery/plot 多维度，可触及 novel 生成栈中任一需要的文件（prose-prompts.ts / skills.ts / generation.ts / quality.ts / blueprint-stage.ts / draft-stage.ts / review-stage.ts / revision-stage.ts / context.ts / fact-* 等）。聚焦实际文案与结构质量提升，而非追逐评分阈值。

## Success Signals

- [x] [intent-preserved] (satisfied) The refined goal brief preserves the user's stated intent and boundaries.
- [x] [evidence-reviewed] (satisfied) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [x] [no-open-required-work] (satisfied) No known required work remains for the refined goal brief.
- [x] [multi-scenario-stable-pass] (satisfied) 至少 2 个不同章节功能（如开篇/承接/转折）+ 至少 2 个不同 POV 角色下，bench/e2e 验证 weighted ≥4.0 且 0 blocker 且 major ≤1，证明优化具泛化性而非过拟合单切片。每个场景需有独立 quality-report 作为证据。
- [x] [top-tier-prose-verified] (satisfied) 在上述多场景中，LLM 与顶尖网络小说参考作品（雪中悍刀行/剑来/庆余年/我在风花雪月里等你等）做 prose 级盲抽检对比时，至少 4 个维度（句式节奏/文白双声部/器物隐喻/群像声音区分/去情绪化/章尾钩子/场景在场感）稳定判定为接近或同级。

## Current Strategy

Refine the broad goal only enough to choose the next evidence-seeking loop; avoid pre-building a task list.

## Next Loop Direction

Future optional iteration can target supporting-character voice differentiation and reduce overlapping environment/process functions using new scenarios, not the completed fixtures.
Progress signal estimate: 100%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

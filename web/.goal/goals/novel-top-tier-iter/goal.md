# Goal

## Objective

通过测试分析产出文章内容，迭代优化小说创作模块（单章 prose / 多章节结构 / 工作流环节 context/blueprint/draft/review/revision/fact 任一）的提示词或流程，目标是产出文章在多场景稳定通过顶尖网络小说水平判据。迭代视角覆盖 prose/structure/voice/hooks/imagery/plot 多维度，可触及 novel 生成栈中任一需要的文件（prose-prompts.ts / skills.ts / generation.ts / quality.ts / blueprint-stage.ts / draft-stage.ts / review-stage.ts / revision-stage.ts / context.ts / fact-* 等）。聚焦实际文案与结构质量提升，而非追逐评分阈值。

## Success Signals

- [x] [intent-preserved] (satisfied) The refined goal brief preserves the user's stated intent and boundaries.
- [ ] [evidence-reviewed] (observed) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [ ] [no-open-required-work] (pending) No known required work remains for the refined goal brief.
- [ ] [multi-scenario-stable-pass] (observed) 至少 2 个不同章节功能（如开篇/承接/转折）+ 至少 2 个不同 POV 角色下，bench/e2e 验证 weighted ≥4.0 且 0 blocker 且 major ≤1，证明优化具泛化性而非过拟合单切片。每个场景需有独立 quality-report 作为证据。
- [ ] [top-tier-prose-verified] (observed) 在上述多场景中，LLM 与顶尖网络小说参考作品（雪中悍刀行/剑来/庆余年/我在风花雪月里等你等）做 prose 级盲抽检对比时，至少 4 个维度（句式节奏/文白双声部/器物隐喻/群像声音区分/去情绪化/章尾钩子/场景在场感）稳定判定为接近或同级。

## Current Strategy

Refine the broad goal only enough to choose the next evidence-seeking loop; avoid pre-building a task list.

## Next Loop Direction

Loop 3：优先修复 P1 短句排比过多（deterministic major，机械可修复）——在 prose-prompts.ts 强化'短句排比上限'约束或在 draft-structure-repair 增加机械后处理；同时评估 P2 POV 越界（'守着/护着'）是否可在 draft 阶段增加机械后校验。目标：将 ch1 场景 majorCount 从 4 降至 ≤1，然后跑第 2 场景（不同章节功能/不同 POV）验证泛化性。
Progress signal estimate: 50%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

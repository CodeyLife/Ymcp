# Goal

## Objective

通过实际运行 bench-draft + bench-review 切片及至少一次完整 e2e 章节验证生成小说正文，与雪中悍刀行/剑来/庆余年等参考作品实际片段做 prose 级对比，识别句式节奏/文白双声部/器物隐喻/去情绪化/章尾钩子/群像声音区分等维度的真实差距；根因分析后优化 novel 生成栈中任一需要的文件（prose-prompts.ts / skills.ts / generation.ts / quality.ts / blueprint-stage.ts / draft-stage.ts / review-stage.ts 等）；反复迭代直到产出正文 prose 质感在 LLM 对比抽检下稳定接近参考作品。迭代视角覆盖 prose/structure/voice/hooks/imagery 多维度。聚焦实际文案质量提升，而非追逐评分阈值。

## Success Signals

- [x] [intent-preserved] (satisfied) The refined goal brief preserves the user's stated intent and boundaries.
- [x] [evidence-reviewed] (satisfied) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [x] [no-open-required-work] (satisfied) No known required work remains for the refined goal brief.
- [x] [prose-parity-verified] (satisfied) 产出正文 prose 质感在 LLM 对比抽检下稳定接近参考作品（雪中悍刀行/剑来/庆余年），至少一次完整 e2e 章节验证 + bench-draft/review 切片对比显示 6 维度差距显著缩小

## Current Strategy

Refine the broad goal only enough to choose the next evidence-seeking loop; avoid pre-building a task list.

## Next Loop Direction

Goal complete。e2e 章节验证成功（weighted 3.92, avg 3.98, 0 blockers），与 bench 切片高度一致（差 0.02），prose 质量改善已稳定。从基线到 e2e 完整改善轨迹：weighted 3.67→3.92（+6.8%），characterVoice 3.69→4.02（+8.9%），specificity 3.04→3.99（+31.3%）。6 维度中 5 个 ≥4.0。核心优化方向全部验证有效。
Progress signal estimate: 100%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

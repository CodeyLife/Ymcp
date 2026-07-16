# Goal

## Objective

通过实际运行 bench-draft + bench-review 切片（及至少一次完整 e2e 章节验证）生成小说正文，将产出与雪中悍刀行/剑来/庆余年等参考作品实际片段做 prose 级对比，识别句式节奏/文白双声部/器物隐喻/去情绪化/章尾钩子/群像声音区分等维度的真实差距；分析根因后优化 novel 生成栈中任一需要的文件（prose-prompts.ts / skills.ts / generation.ts / quality.ts / blueprint-stage.ts / draft-stage.ts / review-stage.ts 等，不局限于 2 个文件）；反复迭代直到产出正文 prose 质感在 LLM 对比抽检下稳定接近参考作品。迭代视角覆盖 prose/structure/voice/pacing/hooks/imagery 多维度，不局限于单一维度。

## Boundaries

- 允许修改整个 novel 生成栈中任一需要的文件（prose-prompts.ts / skills.ts / generation.ts / quality.ts / blueprint-stage.ts / draft-stage.ts / review-stage.ts 等），不局限于 2 个文件。
- 必须通过实际 LLM 运行（bench-draft + bench-review 切片 + 至少一次完整 e2e 章节验证）生成正文产物，不接受 mock。
- 产物存档到 tmp/ 或 .novel-bench/runs/，便于对比与回溯。
- 对比基准是雪中悍刀行/剑来/庆余年/将夜等参考作品的实际片段，不仅看 8 维评分。

## Success Signals

- [ ] [intent-preserved] (pending) Goal brief 保留了用户意图（实际生成测试+读取结果+审视质量+优化 prompt/skill+对比参考作品迭代），边界放开到整个 novel 生成栈（不局限于 2 文件），迭代视角覆盖多维度。
- [ ] [evidence-reviewed] (pending) Loop 1 基于 novel-e2e-deepening 的真实 LLM 产物（6227 字 draft + 8 维 quality report）做分析，证据可追溯。
- [ ] [no-open-required-work] (pending) No known required work remains for the refined goal brief.
- [ ] [real-generation-tested] (pending) Loop 1 复用了 novel-e2e-deepening 的真实 LLM 产物作为 baseline（非 mock），但尚未在本 goal 内独立运行 bench-draft + bench-review。Loop 2 将跑 bench-bootstrap + bench-draft + bench-review 建立 fresh baseline。
- [ ] [prose-comparable] (pending) LLM 对比抽检确认生成正文在至少 4 个 prose 维度（句式节奏/文白双声部/去情绪化/章尾钩子等）上与雪中悍刀行/剑来/庆余年等参考作品片段差距<=1 分（5 分制）。
- [ ] [dim-threshold-met] (pending) 8 维评分中 pacing/characterVoice/sceneEmbodiment/dialogue 四项均>=4.0，0 blockers。
- [ ] [iter-stable] (pending) 连续 2 轮迭代均满足 prose-comparable 和 dim-threshold-met（稳定性验证）。

## Current Strategy

Refine the broad goal only enough to choose the next evidence-seeking loop; avoid pre-building a task list.

## Next Loop Direction

Loop 2：① 跑 bench-bootstrap 生成 fixture（~15min，foundation.json + ch1-blueprint.json + ch1-context-packet.json）；② 跑 bench-draft + bench-review 建立 fresh baseline（~10min）；③ 读取 fresh baseline 的 output.md + quality-report.json，与 Loop 1 baseline 对比确认当前 code 状态；④ 若 fixture 已存在则跳过 bootstrap。Loop 3 开始实施优化方向 #1（prose-prompts 增加参考作品质感锚点）+ #3（quality.ts 扩展检测）+ #5（reviewer 增加参考对比维度）+ #6（skills 增加范本库）。
Progress signal estimate: 0%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

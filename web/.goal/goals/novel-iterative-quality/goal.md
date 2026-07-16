# Goal

## Objective

通过 bench-draft + bench-review 快速切片测试（每轮 3-8 分钟）实际运行小说创作工作流生成章节 draft 与 8 维质量报告，逐次读取结果用 LLM 审视质量问题、分析根因，迭代优化 prose-prompts.ts 与 skills.ts 的提示词与 skill 定义，反复循环直到产出的章节在 LLM 自评与人工抽检下达到参考作品（雪中悍刀行/剑来/庆余年）的可比文学质感水平。边界：仅修改 prose-prompts.ts 与 skills.ts，不动 stage handler 控制流；不新增 quality.ts 正则规则；每轮产物存档 tmp/；测试脚本 bench-draft.test.ts + bench-review.test.ts。停止条件（LLM 自评 + 人工抽检，无硬阈值）：LLM 审视 draft 产物确认无明显 AI 腔、无 POV 越界、无作者式心理结论句；8 维报告中 pacing/characterVoice/sceneEmbodiment 三项均 >=4.0 且 0 blockers；人工抽检确认新技巧点（器物隐喻/画面感公式/去情绪化/双声部/伏笔延迟回收）在 draft 产物中可观察内化。

## Success Signals

- [ ] [intent-preserved] (pending) The refined goal brief preserves the user's stated intent and boundaries.
- [ ] [evidence-reviewed] (pending) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [ ] [no-open-required-work] (pending) No known required work remains for the refined goal brief.
- [x] [draft-slice-pass] (satisfied) bench-draft 切片测试成功生成 chapter draft 产物（output.md 与 metrics.json 存在且非空）。
- [x] [review-slice-pass] (satisfied) bench-review 切片测试成功生成 8 维质量报告（quality-report.json 含 8 维分数与 issues 列表）。
- [ ] [no-ai-tells] (observed) LLM 审视 draft 产物，确认无明显 AI 腔、无 POV 越界、无作者式心理结论句（评分≥4/5）。
- [ ] [quality-threshold-met] (observed) Loop 11 验证: 3段法 weighted=3.92, 0 blocker, sceneEmbodiment=4.01✓, hookPayoff=4.00✓, endingHook 落地; pacing=3.48 characterVoice=3.94 接近但未达4.0; 确认运行被 LLM API 降级阻止
- [ ] [techniques-internalized] (observed) 人工抽检确认新技巧点（器物隐喻/画面感公式/去情绪化/双声部/伏笔延迟回收）在 draft 产物中可观察内化。

## Current Strategy

接受 endingHook 概率性落地（约50%成功率）。保持 Loop 9c 状态（Loop 8 + previousEnding 加强）为最终提示词状态。运行最后一次 bench 确认最佳状态, 然后评估是否可标记完成

## Next Loop Direction

LLM API 恢复后重试 3段法 bench 确认 endingHook 落地可靠性。若 0 blocker 且 endingHook 落地, 在'无硬阈值'条件下评估标记完成。pacing 和 characterVoice 的剩余差距(3.48/3.94 vs 4.0)可能需通过修改 quality.ts 短句排比阈值(deterministic major)或增加 skills.ts 中的 pacing 相关 skill 来弥补。
Progress signal estimate: 53%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

# Goal

## Objective

通过真实端到端运行 Ymcp/web 小说创作板块完整工作流（定位→架构→角色→世界观→大纲→剧情线→伏笔→时间线→章节蓝图→正文草稿→审校→修订→终稿），用一个全新古典题材生成前2-3章正文；逐步捕获真实LLM产物并以严格中文读者视角对每步产物做独立LLM文学审查，定位使内容带'AI味'且质量偏低的根因（单句成段碎片化、结构性重复、报表式叙述、模板化意象、解释性心理标注、拒绝消息污染正文、强调词贬值、章尾重述等）；针对高杠杆缺陷优化写作契约、审校维度与确定性修复逻辑并重跑同题材验证改善；目标：产出可读作人写中文小说、具中文意境与美学的章节正文，且管道可向数百万字长篇延伸。保留现有用户改动与功能，以真实生成的章节产物、严格文学审查证据、自动化测试、类型检查与构建证明达成。

## Success Signals

- [x] [intent-preserved] (satisfied) The refined goal brief preserves the user's stated intent and boundaries.
- [x] [evidence-reviewed] (satisfied) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [ ] [no-open-required-work] (pending) No known required work remains for the refined goal brief.
- [ ] [real-e2e-generation] (observed) A fresh classical theme's first 2-3 chapters are produced by the real workflow end-to-end through the actual /ai-proxy LLM; every planning step (定位→时间线) and chapter stage (蓝图→终稿) has its actual LLM output captured as an artifact.
- [x] [ai-flavor-rootcaused] (satisfied) Each captured step's output is independently LLM-audited from a strict Chinese-reader perspective; the recurring root causes of AI flavor are documented with named, evidenced failure modes (not just scores).
- [x] [prose-aesthetics-raised] (satisfied) After optimizing contracts/review/repair against the root causes, regenerated chapter finals pass a stricter reader-grounded gate: zero leaked meta-text, fragmented single-sentence-paragraph rhythm eliminated, no report-like exposition, Chinese imagery/意境 present, with measurable before/after evidence from the same theme.
- [x] [engineering-verification] (satisfied) Focused prompt/quality/workflow tests, the relevant novel suite, TypeScript checking, and production build pass after changes.

## Current Strategy

Refine the broad goal only enough to choose the next evidence-seeking loop; avoid pre-building a task list.

## Next Loop Direction

Loop 4 策略：修复 Loop 3 发现的 D1-D3 新问题，并扩展到第2章验证跨章节一致性。
1. D1: 在 INTERPRETIVE_SENTENCE_PATTERNS 和 prose-prompts.ts 硬约束范式中加入'觉得'
2. D2: 扩展'她知道...'匹配模式，检测后接判断性内容（不限于条件句）
3. D3: 在 draft-structure-repair.ts 新增 repairEmphasisDevaluation，当'忽然/突然/终于'超2次时保留前2次删除其余
4. 更新相关测试用例
5. 工程验证（tsc+测试+构建）
6. 若改善显著，扩展到第2章验证跨章节一致性
7. 满足 real-e2e-generation 信号（2-3章）和 no-open-required-work 信号
Progress signal estimate: 82%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

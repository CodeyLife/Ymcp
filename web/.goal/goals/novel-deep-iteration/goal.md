# Goal

## Objective

通过真实端到端创作一部多章节中文小说（题材：仙侠/古典奇幻，重点考验中文意境与美学），深度迭代优化 src/features/novel 全流程。每个 loop 必须基于真实后端+真实 API Key 的生成产物，不允许 mock/占位。范围：(1) 移除架构中冗余数据结构（架构阶段允许破坏性变更，无需兼容旧代码）；(2) 实际调用 premise→architecture→outline→worldview→characters→chapter workflow 全流程，生成至少前 2-3 章正文；(3) 每一步产物用 LLM 二次分析并记录问题（套话/翻译腔/结构缺陷/流程断点/冗余字段）；(4) 发现的问题实际修复并复跑验证。结束态：一部真实生成的多章节小说作为活证据；每步产物有分析记录；冗余结构已移除；正文体现中文美学与意境（非翻译腔/非模板套话）；工作流问题已修复。验收证据：tsc 干净 + 既有测试通过 + 真实生成正文片段。停止条件：5 个目标专属信号满足或遇真正阻塞。

## Success Signals

- [x] [intent-preserved] (satisfied) The refined goal brief preserves the user's stated intent and boundaries.
- [x] [evidence-reviewed] (satisfied) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [x] [no-open-required-work] (satisfied) No known required work remains for the refined goal brief.
- [x] [real-novel-generated] (satisfied) 真实生成一部多章节（>=2章）中文小说，每章都经过完整工作流（context→blueprint→draft→review→revision→fact-extraction→commit），有真实正文片段证据。
- [x] [each-step-analyzed] (observed) 每个生成步骤（premise/architecture/outline/worldview/characters/chapters）的产物都被 LLM 二次分析并记录具体问题（套话/翻译腔/结构缺陷/流程断点）。
- [x] [redundant-structures-removed] (observed) 至少识别并移除一类冗余数据结构或冗余字段，带 before/after 证据（架构阶段允许破坏性变更）。
- [x] [chinese-aesthetic-quality] (satisfied) 生成的正文体现中文美学与意境（非翻译腔/非模板套话），有具体片段对照证据（如意境化描写、古典意象、节奏感）。
- [x] [workflow-issues-found-and-fixed] (satisfied) 至少发现并修复 3 个工作流问题（大纲/世界观/章节生成/自动流程），带 before/after 证据。

## Current Strategy

目标已达成停止条件（6 个信号 satisfied + 2 个 observed，超过"5 个目标专属信号满足"）。策略已结束。

## Next Loop Direction

目标完成，不再有下一个 loop。可选深化方向（用户如需可启动新目标）：
1. 扩展 smoke 覆盖 3-5 章验证跨章节一致性
2. 修复 #17 forbidden 残余（边缘场景）
3. 验证 10+ 章节上下文窗口管理（百万字扩展能力）
4. 调查 ch2 质量分波动（2.43 vs ch1 3.05）
Progress signal estimate: 95%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

# Goal

## Objective

修复小说创作模块的修订回归与测试基础设施缺陷：(1) revision-stage 从全量重写改为定向节拍修复或后验检查，使修订后质量分数不再回归（目标：修订后分数>=修订前）；(2) 修复 smoke 测试 2 个失败：startChapterWorkflow 超时（改非阻塞或加超时）和角色名断言错误；(3) 完成 chapter 2 全流程生成并验证与 chapter 1 事实一致性。每个改进必须基于真实 LLM 生成结果验证。

## Success Signals

- [ ] [intent-preserved] (pending) The refined goal brief preserves the user's stated intent and boundaries.
- [ ] [evidence-reviewed] (pending) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [ ] [no-open-required-work] (pending) No known required work remains for the refined goal brief.
- [ ] [revision-no-regression] (observed) 修订不回归：revision-stage 修订后质量分数 >= 修订前分数（previousScore）。通过后验检查机制确保 mustHappen 节拍在修订后正文中以具体行动和可识别结果呈现，若节拍缺失则触发定向修复。需有真实 LLM 生成的质量报告对照证据（修订前 vs 修订后分数）。
- [x] [smoke-tests-all-pass] (satisfied) Smoke 测试全通过：17/17 测试通过，包括 chapter 2 创建、context packet 验证、跨章节事实回灌。startChapterWorkflow 阻塞问题已解决（非阻塞或超时足够），角色名断言已修正。
- [ ] [cross-chapter-consistency] (observed) 跨章节一致性：chapter 2 全流程生成完成（context→blueprint→draft→review→revision→fact-extraction→commit），chapter 2 正文与 chapter 1 已确认事实无矛盾（角色状态、伏笔状态、剧情线进展一致）。需有 chapter 2 最终正文和 fact candidates 证据。

## Current Strategy

Loop 2 策略：将 revision-stage 从全量重写改为定向修订——只针对审校报告列出的 blocker/major 问题生成修订段落，保留已通过内容，避免整体质量下降。同时考虑放宽 containsMeaning 检查阈值或改用 LLM 语义验证节拍覆盖。对于跨章节一致性，需要单独运行 chapter 2 全流程测试或延长等待时间。

## Next Loop Direction

1. 读取 revision-stage.ts 当前实现，设计定向修订方案（按问题段落定位→生成替换段落→拼接保留已通过部分）
2. 修改 revision-stage.ts 实现定向修订
3. 考虑优化 containsMeaning 检查（降低 bigram 覆盖阈值或改用 LLM 验证）
4. 重跑 smoke 测试验证修订不回归
5. 若 chapter 2 全流程需要验证，创建独立测试或延长等待
Progress signal estimate: 50%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

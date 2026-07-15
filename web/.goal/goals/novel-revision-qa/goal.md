# Goal

## Objective

修复小说创作模块的修订回归与测试基础设施缺陷：(1) revision-stage 从全量重写改为定向节拍修复或后验检查，使修订后质量分数不再回归（目标：修订后分数>=修订前）；(2) 修复 smoke 测试 2 个失败：startChapterWorkflow 超时（改非阻塞或加超时）和角色名断言错误；(3) 完成 chapter 2 全流程生成并验证与 chapter 1 事实一致性。每个改进必须基于真实 LLM 生成结果验证。

## Success Signals

- [ ] [intent-preserved] (pending) The refined goal brief preserves the user's stated intent and boundaries.
- [ ] [evidence-reviewed] (pending) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [ ] [no-open-required-work] (pending) No known required work remains for the refined goal brief.
- [ ] [revision-no-regression] (pending) 修订不回归：修订后质量分数 >= 修订前，通过后验检查确保 mustHappen 节拍覆盖，缺失则定向修复。
- [ ] [smoke-tests-all-pass] (pending) Smoke 测试 17/17 全通过，包括 chapter 2 全流程。
- [ ] [cross-chapter-consistency] (pending) 跨章节一致性：chapter 2 全流程完成，与 chapter 1 事实无矛盾。

## Current Strategy

Loop 1 策略：优先解决修订回归（最高优先级）——分析当前 revision-stage 全量重写的问题，设计后验检查机制（修订后验证 mustHappen 节拍覆盖→缺失则定向修复→二次质量检查），然后修复测试基础设施（startChapterWorkflow 非阻塞化+角色名断言修正），最后跑通 chapter 2 全流程验证跨章节一致性。

## Next Loop Direction

Loop 1 切入修订回归：
1. 读取 revision-stage.ts、deterministic-check-stage.ts、quality.ts 理解当前修订→检查流程
2. 设计后验检查：在 revision-stage 生成修订稿后，用 LLM 验证 mustHappen 节拍是否在正文中以具体行动呈现
3. 若缺失，触发定向修复（仅针对缺失节拍生成插入文本，而非全量重写）
4. 修改 shouldAutoRevise 逻辑：如果节拍缺失但分数已达标，仍需定向修复

Progress signal estimate: 0%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

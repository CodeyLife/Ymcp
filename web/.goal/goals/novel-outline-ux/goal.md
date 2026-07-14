# Goal

## Objective

优化小说创作模块的故事大纲展示与 LLM 生成/更新工作流, 覆盖三层: OutlineNode 树(幕/序列/事件)、StoryArchitecture(全书架构)、MatrixView(剧情矩阵)。

【范围】仅限 src/features/novel 下故事大纲相关 UI 与生成逻辑; 不改章节正文工作流、不动角色/时间线/世界观画布(已在前序目标完成)。架构阶段允许破坏性变更, 无需兼容旧代码。

【结束态】
1. 文档式内联审阅/编辑: 整棵大纲树以一份可滚动可折叠的故事文档形态呈现, 多节点同屏可见, 节点上直接展开 summary/causality/outcome, 直接内联编辑, 不再是单节点右侧表单。
2. StoryArchitecture 与 MatrixView 与新大纲文档视觉一致、互相打通, 不出现孤岛视图。
3. LLM 能直接生成与更新三个颗粒度:
   - 整树生成(保留现有能力)
   - 分区定向更新(对单个 act/sequence/event 子树发起 LLM 重写, 兄弟节点保留)
   - 字段级修订(对单节点的 summary/causality/outcome 等单字段发起 LLM 改写)
4. LLM 提议的修改在原树上以可审阅形式(新增/修改/删除标记)呈现, 用户按节点级采纳或拒绝, 不再是脱离上下文的平铺列表。

【证据要求】每个能力必须用真实 API Key 跑一次: 至少 1 次整树生成 + 1 次分区定向更新 + 1 次字段级修订, 阅读 LLM 真实输出验证可用(非模板套话)。dev server 端口 5174。

【默认成功信号】loop_progress, code_compiles, tests_pass

【目标专属成功信号】
- outline-doc-review-ux: 文档式审阅 UI 实现, 浏览器中真实多节点同屏可见+内联编辑可用
- llm-section-targeted-update: 分区定向更新经真实 LLM 验证, 子树替换、兄弟节点保留
- llm-field-level-revision: 字段级修订经真实 LLM 验证, 仅目标字段变化
- architecture-matrix-integrated: StoryArchitecture + MatrixView 同标准升级, 现有大纲生成/采纳流程无回归

【方法】每个 loop 选一个 gap 切入(审阅 UX / 分区更新 / 字段修订 / 整合) -> 实现 -> 真实 LLM 跑 -> 读输出 -> 定位 gap -> 复跑 -> ledger。

【停止】4 个目标专属信号均满足, 且 tsc 干净 + 既有测试通过; 或遇真正阻塞(blocked); 或继续将违反安全/用户意图(unsafe)。

## Success Signals

- [x] [intent-preserved] (satisfied) The refined goal brief preserves the user's stated intent and boundaries.
- [x] [evidence-reviewed] (satisfied) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [x] [no-open-required-work] (satisfied) No known required work remains for the refined goal brief.
- [x] [outline-doc-review-ux] (satisfied) 文档式审阅 UI 实现, 浏览器中真实多节点同屏可见+内联编辑可用
- [x] [llm-section-targeted-update] (satisfied) 分区定向更新经真实 LLM 验证, 子树替换、兄弟节点保留
- [x] [llm-field-level-revision] (satisfied) 字段级修订经真实 LLM 验证, 仅目标字段变化
- [x] [architecture-matrix-integrated] (satisfied) StoryArchitecture + MatrixView 同标准升级, 现有大纲生成/采纳流程无回归

## Current Strategy

Refine the broad goal only enough to choose the next evidence-seeking loop; avoid pre-building a task list.

## Next Loop Direction

Goal complete. 无后续 loop。
Progress signal estimate: 100%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

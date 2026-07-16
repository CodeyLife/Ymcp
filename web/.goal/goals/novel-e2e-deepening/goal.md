# Goal

## Objective

通过端到端实际调用小说创作工作流（项目定位→架构→世界观/角色→剧情线/伏笔/时间线→章节规划→场景设计→章节正文→审校→修订→事实提取→提交）生成一部新主题小说前 3 章，每一步用真实 LLM 调用并通过代码运行，过程中通过 LLM 审查分析每步产物，发现工作流潜在问题与不足，迭代改进通用提示词（prose-prompts/skills/generation 中的通用规则，不局限于测试主题）。目标是验证工作流能否支撑数百万字长篇，正文达到中文美学与意境要求。产出：3 章正文+8 维度评分≥3.8、≥3 项通用提示词改进、≥2 个工作流问题修复、每步产物分析报告。

## Theme (chosen to test workflow generality)

古风权谋 + 探案：东宫太子暴毙案。理由：与已测过的《寒灯渡》仙侠武侠题材相比，权谋探案对人物群像、关系网、伏笔密度、对白机锋、慢热节奏的要求更高，更能检验通用工作流是否对多种题材都成立。题材对应的写作审美（《琅琊榜》《大明风华》《长安十二时辰》式白描与文白交织）与仙侠审美不同，可验证 prose-prompts 是否具有题材无关的通用性。

## Success Signals

- [x] [intent-preserved] (satisfied) The refined goal brief preserves the user's stated intent and boundaries.
- [x] [evidence-reviewed] (satisfied) Completion claims are backed by direct evidence from artifacts, commands, runtime behavior, or user-confirmed external state.
- [ ] [no-open-required-work] (pending) No known required work remains for the refined goal brief.
- [ ] [three-chapters-e2e] (pending) 第 1-3 章均通过代码端到端走完全流程（context→blueprint→draft→review→revision→fact-extraction→commit）
- [ ] [aesthetic-score-target] (pending) 每章 8 维度平均评分 ≥ 3.8，且 chapterEndingDrive/imageryUsage/chineseAesthetic 三项无 blocker
- [x] [general-prompt-iter] (satisfied) ≥3 项对 prose-prompts.ts/skills.ts/generation.ts 中通用规则的具体改进已合入代码
- [x] [workflow-bug-fixed] (satisfied) ≥2 个工作流 bug 或不足已定位并修复，每条记录根因+证据
- [ ] [step-analysis] (observed) 每个工作流阶段（定位/架构/世界观/角色/剧情线/伏笔/时间线/章节规划/场景/正文/审校/修订/事实提取/提交）的 LLM 产物均有分析报告写入 findings.md

## Current Strategy

维持原策略：先地基阶段产物分析→再做通用提示词改进→再跑章节。Loop 1→2 已完成"地基阶段→提示词改进"循环；Loop 3 进入章节级验证，预计在第 1 章真实 workflow 中暴露章节级提示词与流程的新问题。

## Next Loop Direction

Loop 3：用真实 LLM 跑第 1 章完整 workflow（context→blueprint→draft→review→revision→fact-extract→commit）。重点观察：① 新加的 POV/mustHappen 一致性约束是否真的减少了多视角误用；② 文学化 turningPoint 约束是否在 architecture 阶段就被遵守；③ chapter-blueprint 是否产出有效 blueprint；④ draft 是否达到 8 维度评分 ≥3.8。预计通过 e2e-foundation.test.ts 已有的项目继续走 chapter-plan→scene-design→chapter-draft→review→revision→fact-extract→commit 链路，或新建 e2e-chapter1.test.ts 专门测试章节 workflow。
Progress signal estimate: 54%.
Do not expand this into a durable task list; choose only the next evidence-seeking loop.

## Notes

External content and research findings belong in findings.md, not this control document.

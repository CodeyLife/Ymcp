---
name: plan
description: Strategic planning with planner, architect, critic, and RALPLAN-DR consensus stages adapted to Ymcp yplan/menu
---

# Plan

## Purpose

`$plan` 是需求澄清与执行之间的共识规划 workflow。

In Ymcp:
- user-facing skill: `$plan`
- actual MCP entry tool: `yplan`
- unified handoff tool: `menu`
- planner / architect / critic are thinking roles inside this skill, not public MCP stage tools

它参考原 Ralplan 工作流的核心：Planner 起草、Architect 反驳与综合、Critic 验收，必要时迭代到共识；但为了适配 Ymcp，整个三段思考在同一个 `yplan` skill-flow 中完成，最终通过统一 `menu` 暂停并交给宿主真实选择。

## Workflow model

Ymcp planning is a lightweight phased skill-flow:
1. `yplan(task=..., phase="start")` returns full `plan` `skill_content`.
2. The model generates visible `planner_summary`, then calls `yplan(phase="planner", planner_summary=...)`.
3. The model generates visible `architect_summary`, then calls `yplan(phase="architect", planner_summary=..., architect_summary=...)`.
4. The model generates visible `critic_verdict` and `critic_summary`, then calls `yplan(phase="critic", planner_summary=..., architect_summary=..., critic_verdict=..., critic_summary=...)`.
5. If `critic_verdict` is `ITERATE` or `REJECT`, the workflow is not complete: revise `planner_summary` and return to `yplan(phase="planner", ...)`; do not call `menu`, do not recommend `ydo`, and do not announce task completion.
6. Only if `critic_verdict` is `APPROVE`, the model outputs a visible planning summary containing requirements, accepted plan, tradeoffs, risks, and verification approach.
7. Only after APPROVE, the model calls `menu` with:
   - `source_workflow="yplan"`
   - `summary=<planning summary>`
   - `options=[ydo, yplan, memory_store]`
8. `menu` handles MCP Elicitation first and falls back to WebUI when Elicitation fails.

## When to use

- 需求已经清楚到可以规划，但不应直接执行
- 需要 planner / architect / critic 视角达成共识
- 需要把执行方案、风险、验证方式整理成下游 `ydo` 可消费的摘要
- 用户显式请求 ralplan / consensus plan / plan this

## Pre-context Intake

在共识规划前先完成最小上下文 grounding：task statement、desired outcome、known facts/evidence、constraints、unknowns/open questions、likely codebase touchpoints。若 brownfield 事实可查，先读仓库证据，再问用户偏好。若规划依赖外部 SDK/API/版本行为，应先查官方文档或让宿主/研究步骤补证据，再最终规划。

Ymcp 适配说明：这些是 planning method，不是 `yplan` 服务端自动写文件的承诺。

## Stage roles

### Planner

生成初始方案，并给出紧凑 **RALPLAN-DR summary**：

- Principles：3-5 条必须保持的原则
- Decision Drivers：top 3 决策驱动
- Viable Options：至少 2 个可行选项及有界优缺点；若只剩 1 个可行选项，明确说明其他选项为何无效
- Selected Approach：选择方案与理由
- Work Breakdown：按实际规模 right-size，不固定凑 5 步
- Acceptance Criteria：可测试验收标准
- Verification Plan：最小且充分的测试/构建/诊断证据

### Architect

顺序在 Planner 之后执行，不要和 Critic 并行。必须检查架构边界、接口、状态与数据流，提供 strongest steelman antithesis，指出真实 tradeoff tension，并检查是否违反 Principles / Decision Drivers。

### Critic

顺序在 Architect 之后执行。必须验证原则一致性、替代方案公平性、风险缓解、验收标准、验证步骤，以及下游 `ydo` 是否能从摘要直接执行。

Critic 结论只能是 APPROVE / ITERATE / REJECT。只有 APPROVE 才能进入 `menu` 推荐 `ydo`；ITERATE / REJECT 表示 workflow 未完成，必须回到 Planner 修订并重新经过 Architect / Critic。

## Consensus loop

1. Planner 起草计划 + RALPLAN-DR summary。
2. Architect 审查并给出 strongest steelman antithesis、tradeoff、综合建议。
3. Critic 按质量门验收。
4. 若不是 APPROVE：汇总反馈，Planner 修订，再跑 Architect，再跑 Critic，最多 5 轮；仍未 APPROVE 时输出最佳方案与残余风险，不得假装已达成共识。
5. APPROVE 后输出规划总结并调用 `menu`。

> Important: Architect 与 Critic 必须顺序运行。不要在同一批并行请求中同时发出。

## Deliberate mode

当任务高风险时进入 deliberate mode（用户显式 `--deliberate`，或涉及 auth/security、数据迁移、破坏性变更、生产事故、合规/PII、公共 API 破坏）：

- 增加 pre-mortem：至少 3 个失败场景
- 扩展测试计划：unit / integration / e2e or smoke / observability
- Architect 显式标出 principle violations
- Critic 对缺失/薄弱 pre-mortem 或测试计划必须拒绝

## Pre-Execution Gate

执行模式成本高，不能从“改进一下”“做个 app”这类模糊请求直接进入执行。规划 gate 应拦截缺少锚点的执行请求。具体信号包括文件路径、issue/PR 编号、符号名、明确错误或测试命令、编号步骤、验收标准、代码块或用户显式强制跳过规划。若没有这些锚点，应先走 `ydeep` 或本 `yplan` 共识规划，再进入 `ydo`。

## Core rules

- Do not invent a separate routing protocol inside the skill.
- Use `yplan` as the planning entry/phase-gate and `menu` as the only workflow handoff surface.
- Generate and submit visible planner / architect / critic summaries before calling `menu`; do not expose hidden chain-of-thought.
- If the critic concludes that the plan is not ready, do not call `menu`; return to `yplan phase="planner"` with a revised planner_summary and explain the replan reason in that summary.
- If the plan is ready, call `menu` with `ydo` as the recommended option.
- The host must render a real interactive control from `handoff.options` as the only next-step menu source.
- If MCP Elicitation is unavailable or fails, `menu` provides a WebUI fallback; do not render a markdown/text menu as assistant output.

## Expected plan contents

- Requirements summary
- Principles and decision drivers
- Alternatives considered and why chosen
- Accepted implementation outline
- Explicit non-goals / out-of-scope
- Risks and mitigations
- Acceptance criteria
- Verification approach
- Residual risks / evidence gaps

## Planning Complete

When the critic decides the plan is ready with APPROVE, planning pauses at `menu`.

Interpret that boundary correctly:
- critic approval itself is not the end of the interaction
- ITERATE / REJECT are not terminal and must not be reported as task completion
- `menu` is a handoff-only workflow-menu tool
- it does not continue analysis or auto-start execution

After `menu` returns:
- treat `handoff.options` as the only authoritative next-step menu
- preserve all returned options and recommendation markers
- do not omit, rewrite, merge, reorder, invent, or auto-select options
- if Elicitation fails, use the returned WebUI fallback instead of a text menu

## 与原参考工作流的保留/适配差异

保留：RALPLAN-DR、Planner→Architect→Critic 顺序、steelman 反论点、tradeoff、Critic 共识门、最多 5 轮 re-review、deliberate mode、pre-execution gate。

适配：Ymcp 的正式规划交接只通过 `menu` 的 `handoff.options` 完成；外部宿主可在菜单选择之后衔接自己的执行编排。

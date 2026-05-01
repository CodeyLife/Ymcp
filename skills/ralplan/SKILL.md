---
name: ralplan
description: Alias for $plan --consensus, adapted to Ymcp yplan/menu lightweight workflow
---

# Ralplan

## What it means in Ymcp

`ralplan` is the consensus-planning alias for `$plan --consensus`.

在当前项目中，它表示：调用 `yplan`，按 `phase=start → planner → architect → critic` 在同一个 plan skill-flow 内完成 Planner / Architect / Critic 共识规划总结，然后通过统一 `menu` 交接。

## Restored intent from reference workflow

参考工作流的核心思想仍然保留：

- RALPLAN-DR：Principles、Decision Drivers、Viable Options、选择理由
- Planner 先起草，Architect 再审查，Critic 最后验收
- Architect 必须提供 strongest steelman antithesis 与真实 tradeoff
- Critic 必须检查原则一致性、替代方案公平性、风险缓解、验收标准和验证步骤
- 非 APPROVE 时进入 closed re-review loop，最多 5 轮
- 高风险任务启用 deliberate mode：pre-mortem + 扩展测试计划
- 模糊执行请求先过 planning gate，不直接执行

## Practical rule

Use `yplan(task=..., phase="start")` and follow `skills/plan/SKILL.md`.

完成规划后不要直接执行；输出规划总结并调用 `menu`：

- `source_workflow="yplan"`
- `summary=<规划总结>`
- `options=[ydo, yplan, memory_store]`

`handoff.options` 是下一步唯一权威来源。不要自动选择推荐项。

## Ymcp adaptation boundary

Ymcp 版本的公共工作流入口是：`ydeep`、`yplan`、`ydo`、`menu`。因此：

- 规划 artifact 可以在摘要中提供，也可由宿主保存；不要声称服务端已自动写入文件
- 下游执行正式入口是 `ydo`
- 若宿主将 `ydo` 映射到更强执行器，应保持本规划里的原则、非目标、验收与验证要求

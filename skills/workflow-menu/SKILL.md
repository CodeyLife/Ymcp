---
name: workflow-menu
description: 用于描述和处理 Ymcp workflow 流程菜单、handoff.options、流程菜单阶段下一步选择、selected_option 回传、宿主可交互控件渲染，以及避免 assistant 输出 markdown 菜单、自动选择推荐项或误判为结束对话。
---

# Workflow Menu

## 目的

当工具返回流程菜单时，使用本技能指导 assistant 正确理解和表达交互需求。

流程菜单不是最终回答，也不是结束对话。它是一个受限的需求澄清步骤：收集用户下一步想进入哪个流程。

## 字段读取规则

菜单项必须从协议指定字段读取，不能使用固定默认项，不能自行生成菜单。

在 Ymcp 中：

- 菜单项读取：`meta.handoff.options`
- 合法选择值读取：每个 option 的 `value`
- 展示标题读取：每个 option 的 `title`
- 展示说明读取：每个 option 的 `description`
- 推荐标记读取：每个 option 的 `recommended`
- 回传字段：`selected_option`

`recommended_next_action` 和 `recommended: true` 只表示推荐，不表示用户已经选择，也不授权自动继续。

## 正确语义

当 流程菜单阶段返回 `meta.handoff.options` 时，应理解为：

- 宿主需要展示真实可交互菜单
- 用户需要选择下一步流程
- assistant 不应继续分析、代选或自行进入下一流程
- 用户选择的 option `value` 必须作为 `selected_option` 回传当前流程菜单 tool

这一步收集的是“下一步流程需求”，不是开放式业务需求。

## 推荐措辞

使用类似措辞：

> 宿主必须读取 `meta.handoff.options` 中的菜单项，向用户展示可交互流程选择，并收集用户下一步想进入哪个流程的需求。用户选择后，宿主必须将所选 option 的 `value` 作为 `selected_option` 回传当前流程菜单 tool。

## 禁止行为

- 不要输出 markdown/text 菜单替代宿主 UI。
- 不要固定写死默认选项。
- 不要自动选择 recommended 项。
- 不要改写、合并、删减、重排或新增 options。
- 不要把 `title` 或 `description` 当作回传值。
- 不要把 流程菜单阶段解释为“任务已完成，结束对话”。
- 不要问开放式问题，例如“还有什么需求？”，除非某个 option 明确表示继续澄清。
- 不要从 `meta.ui_request.options` 读取菜单项；Ymcp 菜单项来源是 `meta.handoff.options`。

## 宿主交互流程

宿主应按以下顺序处理：

1. 读取 `meta.handoff.options`。
2. 将每个 option 渲染为可交互控件。
3. 展示 `title`，可用 `description` 作为说明。
4. 保留 `recommended` 作为推荐标记，但不得自动选择。
5. 用户选择后，读取所选 option 的 `value`。
6. 重新调用当前流程菜单 tool，并传入 `selected_option=<value>`。

## Assistant 行为

当流程菜单已返回：

- 停止普通分析输出。
- 不继续调用下一流程。
- 不把 options 改写成聊天文本菜单。
- 等待宿主 UI 选择，或等待显式 `selected_option` tool call。

## 好的摘要模板

```text
WORKFLOW_PAUSED_AWAITING_SELECTED_OPTION:
宿主必须读取 meta.handoff.options 中的菜单项，收集用户下一步想进入哪个流程的需求；
用户选择后，宿主必须将所选 option.value 作为 selected_option 回传当前流程菜单 tool；
assistant 不得输出文本菜单、自动选择推荐项或继续进入下一流程。
```

## 错误示例

避免：

- “任务已完成，结束对话。”
- “请选择：1. ydo 2. restart 3. memory_store”
- “我将自动进入推荐的 ydo。”
- “你还有什么补充需求？”
- “根据 recommended_next_action，我继续下一步。”

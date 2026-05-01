# 当前 MCP 工作流流程图

> 当前公开 workflow tools：`ydeep`、`yplan`、`ydo`、`menu`。
> `menu` 是唯一流程菜单 tool；优先 MCP Elicitation，失败时提供 localhost WebUI fallback。

***

## 1. `ydeep` → `menu`

```mermaid
flowchart TD
    A[用户需求模糊] --> B[调用 ydeep]
    B --> C[返回 deep-interview skill_content]
    C --> D[LLM 完成需求调研并输出 summary]
    D --> E[调用 menu source_workflow=ydeep]
    E --> F[yplan]
    E --> G[refine_further]
```

## 2. `yplan` → `menu`

```mermaid
flowchart TD
    A[进入规划] --> B[调用 yplan]
    B --> C[phase=start 返回 plan skill_content]
    C --> D[输出 planner_summary]
    D --> E[调用 yplan phase=planner]
    E --> F[输出 architect_summary]
    F --> G[调用 yplan phase=architect]
    G --> H[输出 critic_verdict 和 critic_summary]
    H --> I[调用 yplan phase=critic]
    I --> O{critic_verdict}
    O -->|ITERATE/REJECT| D
    O -->|APPROVE| J[输出最终规划 summary]
    J --> K[调用 menu source_workflow=yplan]
    K --> L[ydo]
    K --> M[yplan]
    K --> N[memory_store]
```

## 3. `ydo` → `menu`

```mermaid
flowchart TD
    A[进入执行阶段] --> B[调用 ydo]
    B --> C[返回 ralph skill_content]
    C --> D[LLM 完成执行 / 修复 / 验证]
    D --> E[输出执行 summary]
    E --> F[调用 menu source_workflow=ydo]
    F --> G[finish]
    F --> H[memory_store]
    F --> I[yplan]
    F --> J[continue_execution]
```

## 4. `menu` fallback

- `handoff.options` 是下一步动作的唯一权威源。
- `menu` 优先调用 MCP Elicitation。
- Elicitation unsupported / failed / invalid / declined / cancelled 时，`menu` 返回 `blocked`，并在 `meta.ui_request.webui_url` 提供真实可交互 WebUI。
- WebUI 使用随机 token；只允许查看当前菜单和提交合法 option value。
- assistant 不得用普通文本或 markdown 列表代渲染菜单，也不得自动选择 recommended 项。

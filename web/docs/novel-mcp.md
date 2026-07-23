# Novel Runtime MCP

小说 MCP 直接连接本机常驻运行时，不再转发到浏览器标签页。SQLite 是正式数据源；浏览器仅作为 UI，关闭页面不会停止已经排队或正在执行的创作 operation。

## 启动

开发环境运行：

```powershell
npm run dev
```

该命令同时启动本地小说运行时和 Vite。只需要运行 MCP 时可直接配置：

```json
{
  "mcpServers": {
    "ymcp-novel": {
      "command": "node",
      "args": ["F:\\GitHubProject\\Ymcp\\web\\scripts\\novel-mcp-server.mjs"]
    }
  }
}
```

MCP adapter 会检查 `http://127.0.0.1:4766/v1/health`，运行时不存在时自动后台启动。可用环境变量：

- `YMCP_NOVEL_RUNTIME_URL`：覆盖运行时地址。
- `YMCP_NOVEL_DATA_DIR` / `YMCP_NOVEL_DB_PATH`：覆盖 SQLite 数据位置。
- `YMCP_API_BASE_URL`、`YMCP_API_KEY`、`YMCP_MODEL_CONTEXT_WINDOW`：为无 UI 环境提供模型配置。
- `YMCP_NOVEL_MCP_PROFILE=advanced`：额外暴露旧 run/work/rule 诊断工具。

运行时要求 Node.js 24 或更高版本，默认数据库为 `%LOCALAPPDATA%\Ymcp\novel-runtime.sqlite`。

## 默认工作流

1. 调用 `novel_project_list`，或用 `novel_project_create` 创建项目。
2. 用 `novel_project_select` 按完整标题或 ID 选择一次项目；创建项目会自动选择。
3. 调用 `novel_plan`、`novel_write` 或 `novel_revise`。工具立即返回持久化 `operationId`。
4. 用 `novel_operation_get` 或 `novel_status` 读取后台进度；失败且根因已修正时，用 `novel_operation_retry` 从原工作项继续。
5. operation 产生候选后，用 `novel_change_get` 读取并审核完整产物。
6. 用 `novel_change_review` 接受、拒绝或要求重做，并提供 `reviewerId` 与 `model`；不要仅凭候选摘要盲目接受。

项目级工具可用 `projectRef` 临时覆盖当前选择。没有选择时不会猜测最近项目；同名项目不会模糊匹配。MCP 创建的 operation 固定为 `external-mcp` driver，只接受带模型身份的 `external-llm` 审核；UI 创建的 operation 固定为 `human` driver，只接受用户审核。接受候选前运行时会校验正式项目快照，检测到并发修改时返回 `SNAPSHOT_CONFLICT`。

`novel_status` 和 `novel_operation_get` 返回结构化 `nextActions`。调用模型只能从这些动作中选择，不应绕过审核门或自行猜测运行状态。

## 规则改进闭环

默认 profile 直接提供意图级工具：

- `novel_improvement_propose`：记录症状、失败层、根因机制、影响输入类别、边界和回归风险，创建不可变规则候选。
- `novel_improvement_evaluate`：对章节或基础设定任务运行隔离基线/候选 A/B；需要在实质不同的场景上重复执行。
- `novel_improvement_get`：读取证据、审核记录和未满足的晋升门禁。
- `novel_improvement_review`：提交剧情、人物、文笔或长篇编辑的独立审核。
- `novel_improvement_promote`：仅在跨场景证据与全部审核门通过后晋升。
- `novel_improvement_rollback`：回滚已晋升版本。

单次低分或单个样例不能直接修改正式 Skill、系统 Prompt 或流程。`advanced` profile 继续暴露旧低层工具，只用于诊断与兼容。

## 断线与恢复

- operation、事件、租约和候选全部持久化在 SQLite。
- MCP 断开不会取消 operation。
- 运行时重启会立即回收上一个进程持有的 operation 租约；已进入待审核状态的产物会重建候选状态而不会重复生成。
- 变更确认是独立幂等请求，重复确认不会重复写入正式稿。
- 正式项目记录、change、operation 和提交收据在同一 SQLite 事务中提交；失败时运行投影从 SQLite 正式状态恢复。

## 旧项目迁移

完整小说编辑工作台和统一创作任务面板都位于 `/novels`；旧 `/novel-runtime` 路径会重定向到项目中心。项目尚未进入运行时时，可在项目内的“创作任务”页执行一次性迁移：

1. 浏览器读取所选项目全部 project-scoped 表以及用户级 Skill。
2. 生成 SHA-256 完整性摘要。
3. 运行时先在 `%LOCALAPPDATA%\Ymcp\backups` 写入迁移前归档。
4. 校验通过后，在一个 SQLite 事务中导入记录和非敏感模型配置。

API Key 不进入迁移归档或主 SQLite，而是单独保存到用户本地数据目录下权限受限的 `novel-runtime.secrets.json`。

原 IndexedDB 不会删除，可作为人工回滚来源；迁移摘要有幂等收据，同一归档不会重复导入。

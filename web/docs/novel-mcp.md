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

## 自迭代工作流

1. 调用 `novel_project_list`，或用 `novel_project_create` 创建项目；再以 `novel_project_select` 选择项目。
2. 每次开始、恢复 operation 或处理候选前，先调用 `novel_agent_guide_get`；它返回不可跳过的审核顺序、当前 `nextActions` 与经验沉淀边界。
3. 调用 `novel_plan`、`novel_write` 或 `novel_revise`。工具立即返回持久化 `operationId`；用 `novel_autopilot_get`、`novel_operation_get` 或 `novel_status` 读取运行时允许的下一步。
4. operation 产生候选后，必须调用 `novel_change_get` 读取完整产物和 `artifactFingerprint`。项目内部质量门与外部 LLM 审核是两个独立门禁。
5. 外部审核必须给出 `reviewRunId`、模型身份、结论、问题严重度、证据、建议、完整候选指纹，以及本轮“无需沉淀”或“应提议规则改进”的经验判断。`propose-improvement` 必须先调用 `novel_learning_target_get`，携带返回的 `targetVersion`、`targetContentFingerprint`，并基于返回的当前全文提交完整修订文本、影响输入类别、底层机制、边界、非目标和回归风险；目标在审核后变化时运行时拒绝旧提案，不能只发送 learning 事件。只允许三种处理：
   - `accept`：用 `novel_change_review` 提交 `passed` 审核。仅项目内部证据没有 blocker/major 且外部审核通过时，才自动写入正式项目。
   - `patch`：对有稳定 proposal item 定位的小问题调用 `novel_change_patch`。补丁使用 `novel_change_get.itemPayloadFingerprints[itemId]` 返回的原 payload 指纹，并携带关联问题和理由；之后依次调用 `novel_change_revalidate`、`novel_change_get` 和新的外部审核。
   - `regenerate`：用 `novel_change_review` 提交 `revise` 审核；运行时会带着审核意见回到原 work item 生成完整替代候选。
6. 外部 MCP 质量循环没有固定轮数。质量问题持续进入 patch 或 regenerate；只有运行失败、快照冲突或不可恢复的契约错误才使用 `novel_operation_retry`。

项目级工具可用 `projectRef` 临时覆盖当前选择。没有选择时不会猜测最近项目；同名项目不会模糊匹配。MCP 创建的 operation 固定为 `external-mcp` driver，只接受带模型身份的 `external-llm` 审核；UI 创建的 operation 固定为 `human` driver，只接受用户审核。接受候选前运行时会校验正式项目快照，检测到并发修改时返回 `SNAPSHOT_CONFLICT`。

`novel_status`、`novel_operation_get` 与 `novel_autopilot_get` 返回结构化 `nextActions`。调用模型只能从这些动作中选择，不应绕过审核门、候选指纹或自行猜测运行状态。局部补丁只更新待审核 proposal，不能直接修改正式正文。

## 规则改进闭环

默认 profile 直接提供意图级工具：

- `novel_improvement_propose`：记录症状、失败层、根因机制、影响输入类别、边界和回归风险，创建不可变规则候选。
- `novel_improvement_evaluate`：对章节或基础设定任务运行隔离基线/候选 A/B；需要在实质不同的场景上重复执行。
- `novel_improvement_get`：读取证据、审核记录和未满足的晋升门禁。
- `novel_improvement_review`：提交剧情、人物、文笔或长篇编辑的独立审核。
- `novel_improvement_promote`：仅在跨场景证据与全部审核门通过后晋升；只有来源 operation 开启 `autoPromote` 的 learning 候选会自动晋升。
- `novel_improvement_rollback`：回滚已晋升版本。

每轮候选终结时都应总结问题是否指向共享机制。单次低分或单个样例不能直接修改正式 Skill、系统 Prompt 或流程；规则候选仍须覆盖多个实质不同场景，并通过四类独立编辑审核。新版本激活后会使用 learning 保存的冻结失败场景立即回归，确认实际版本 provenance、blocker/major 和质量分；缺少重放信息、版本不符或回归失败时自动恢复上一版本并保存失败证据。`advanced` profile 继续暴露旧低层工具，只用于诊断与兼容。

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

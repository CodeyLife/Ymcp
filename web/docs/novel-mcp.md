# Novel MCP V2

The MCP server in `scripts/novel-mcp-server.mjs` talks only to the V2 API (`NOVEL_V2_API_URL`, default `http://127.0.0.1:4770`). It no longer bridges browser IndexedDB or the previous `/v1/projects` runtime.

## Tools

- `novel_intent_submit` submits a creative intent. The runtime performs preflight, memory retrieval, Skill resolution, blueprint compilation, and durable workflow execution.
- `novel_run_get` reads a Temporal workflow status.
- `novel_run_events_get` reads persisted project outbox events for a workflow.
- `novel_preflight_get`, `novel_memory_bundle_get`, `novel_skill_bundle_get`, `novel_context_get`, and `novel_artifact_get` inspect frozen V2 records.
- `novel_work_claim`, `novel_work_heartbeat`, `novel_artifact_submit`, `novel_review_submit`, and `novel_work_fail` send workflow signals. The workflow records lifecycle events and does not depend on a browser tab staying open.

## Operating contract

- MCP clients submit intents or task signals; they do not mutate formal manuscript data directly.
- Formal commits must pass through `CommitService` and require current internal plus independent review evidence bound to the artifact fingerprint.
- Memory retrieval is resolved before the execution blueprint is compiled; agents should inspect `memory_bundle` and `execution_blueprint` records when debugging context quality.
- Local credentials belong in ignored env files or process environment, never in tracked docs, MCP payload logs, or memory files.

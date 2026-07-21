# Novel Workflow MCP

The MCP server exposes the live novel project currently open in Ymcp. The browser remains the data owner because project records are stored in IndexedDB; the stdio server forwards validated MCP calls over a localhost WebSocket bridge.

## Start

1. Start Ymcp with `npm run dev` and open the target novel project.
2. Configure the MCP client to launch `scripts/novel-mcp-server.mjs`.
3. Call `novel_bridge_status` first and use its `projectId` in every later tool call.

Example MCP client configuration on Windows:

```json
{
  "mcpServers": {
    "ymcp-novel": {
      "command": "node",
      "args": ["F:\\GitHubProject\\Ymcp\\web\\scripts\\novel-mcp-server.mjs"],
      "env": {
        "YMCP_MCP_BRIDGE_PORT": "4765",
        "YMCP_MCP_REQUEST_TIMEOUT_MS": "900000",
        "YMCP_MCP_TOKEN": ""
      }
    }
  }
}
```

For a shared token, set the same non-empty value in `YMCP_MCP_TOKEN` for the MCP process and `VITE_YMCP_MCP_TOKEN` in `.env.local`, then restart the Vite server. Production builds must also set `VITE_YMCP_MCP_BRIDGE_ENABLED=true` when the bridge is required.

## External workflow

1. `novel_run_create`
2. `novel_action_execute` with `action: "work.enqueue"`
3. Repeatedly inspect `novel_action_list`, execute available work, and read returned artifacts.
4. Submit an `external-llm` review through `novel_review_submit`.
5. A passed review auto-accepts the result. A revise/blocked review exposes `work.revise` until the run iteration limit is reached.
6. `novel_run_complete` verifies that no unfinished work or unresolved major issue remains.

Every tool except `novel_bridge_status` requires the connected `projectId`. Mutating calls also require stable idempotency keys.

## Three execution modes

The three modes share the same creative work model and review gate; they differ only in who advances and who may commit:

| Mode | Entry | Advancement | Commit authority |
| --- | --- | --- | --- |
| Manual | Studio generation, chapter workflow, and Skill Center rule-governance controls | User starts each step, runs isolated rule A/B evaluations, and reviews the result | User |
| Segment auto | Thunderbolt action on a plot segment or phase | Controller generates the segment chapters in dependency order and runs internal review/revision | Quality gate |
| External | MCP tools in this document | External LLM discovers legal work, starts it, reads artifacts, submits review, and iterates | A passing `external-llm` or user review |

Content review never edits a Skill or system Prompt. A passed chapter review may promote the manuscript and accepted facts only. Rule changes use the separate workflow below.

## Discovery and recovery

Call `novel_catalog_get` before planning work. It returns phases, plot segments, chapters, legal generation task keys, supported work kinds, workflow definitions, effective Skills, immutable Skill versions, system Prompt versions, and existing rule candidates. Use `novel_rule_target_get` with an optional `version` to read the complete Skill or system Prompt text before proposing a replacement. Do not invent task keys or use internal work kinds.

`work.start` creates a renewable execution lease. If a client disconnects and a work item remains `running` after the lease expires, execute `work.recover` with a new idempotency key to return it to `queued`. `force: true` is reserved for an operator who has confirmed that the original worker is no longer active.

## Cautious Skill and Prompt evolution

System rules are versioned, evaluated, promoted, and rolled back independently from manuscript generation. The server does not automatically infer a global rule from one weak chapter.

The same lifecycle is available to a user in **Skill Center → Rule candidates**. MCP is the programmable surface for an external LLM; both surfaces call the same service and gate implementation.

1. Use `novel_catalog_get` to select an effective `skillId` or `templateId`, then read its complete current text with `novel_rule_target_get`.
2. Create a candidate with `novel_rule_candidate_create`. Its `scope` must state the observed symptom, failing layer, underlying mechanism, affected input class, intended benefits, boundaries, non-goals, and regression risks.
3. For each scenario, enqueue two `chapter-workflow` items for the same `targetId` in isolated dry runs:

```json
{
  "kind": "chapter-workflow",
  "targetId": "chapter-id",
  "instruction": "Write and evaluate this chapter",
  "parameters": { "evaluationRole": "baseline", "ruleCandidateId": "candidate-id", "scenarioClass": "action-under-pressure" }
}
```

```json
{
  "kind": "chapter-workflow",
  "targetId": "chapter-id",
  "instruction": "Write and evaluate this chapter",
  "parameters": {
    "evaluationRole": "candidate",
    "ruleCandidateId": "candidate-id",
    "scenarioClass": "action-under-pressure"
  }
}
```

4. Start and review both items normally. Evaluation items remain isolated even after acceptance; they never overwrite the formal manuscript or active rules.
5. Submit chapter pairs with `novel_rule_evidence_submit`, or use `novel_rule_foundation_evaluate` for foundation-only targets. Repeat until evidence covers at least three structurally distinct chapters or foundation tasks; renaming `scenarioClass` does not create a new scenario.
6. Submit four rule-level reviews with `novel_rule_review_submit`: `plot-editor`, `character-editor`, `prose-editor`, and `long-form-editor`. Each review must include `reviewerId`, a unique `reviewRunId`, and the external `model`; the gate requires at least two independent reviewer identities.

Every mutating tool reserves a durable idempotency receipt before executing. Query `novel_receipt_get` with the original tool name and key to distinguish `pending`, `completed`, and `failed`; a `pending` receipt is never replayed automatically because its side effects may already exist.
7. Inspect `novel_rule_candidate_get`. Promotion requires all four latest reviews to pass, no new blocker/major issue, no per-scenario regression above 0.2, and an average quality gain of at least 0.1.
8. Use `novel_rule_promote` only when the gate is ready. Promotion creates a new immutable patch version and atomically switches the active binding.
9. Use `novel_rule_rollback` to switch back to the evaluated baseline version without deleting history.

The catalog marks targets with `chapterEvaluationEligible`. The current governance flow only accepts targets that actually participate in the isolated chapter workflow. Foundation-only rules require a separate foundation evaluator and are rejected rather than being scored from unrelated chapter noise.

The three required scenario classes must represent different creative functions or conditions, such as action versus aftermath versus setup, different points of view, or materially different genres and prose registers. Renaming the same fixture does not provide cross-scenario evidence.

## Long-form quality contract

The built-in `long-form-master-craft` Skill and `long-form-fiction-master` system Prompt carry the shared standard across planning, drafting, review, and revision. The standard distills reusable strengths of leading serialized fiction without copying a title or author style:

- A durable premise continues producing choices and consequences after the opening hook.
- Macro arcs, plot segments, chapters, and scenes each have their own payoff horizon; a chapter does not consume future revelations merely to feel eventful.
- Causality, escalation, subplots, foreshadowing, and reversals alter later choices instead of decorating an outline.
- Characters possess desires, fears, knowledge boundaries, moral limits, distinct voices, and costly agency; the ensemble continues acting when off page.
- Action, setup, aftermath, intimacy, discovery, and payoff chapters form a readable rhythm rather than one repeated intensity curve.
- Prose uses concrete sensory selection, viewpoint-specific imagery, subtext, silence, and restraint. Imagery changes meaning with context and serves the scene rather than displaying vocabulary.
- Continuity tracks facts, relationships, injuries, resources, promises, time, and information ownership across a manuscript that may reach millions of words.

These are evaluation dimensions, not a checklist that every chapter must visibly satisfy. Genre promise, chapter function, narrative distance, and the project's chosen voice remain controlling context.

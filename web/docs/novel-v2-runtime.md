# Novel V2 Runtime

Novel V2 is the direct replacement for the previous browser/SQLite novel runtime. Web is a presentation client; durable state lives in PostgreSQL, long-running work is owned by Temporal, object content is stored through the object-store seam, and memory retrieval is PostgreSQL lexical plus optional Qdrant semantic recall.

## Local stack

1. Copy `.env.example` to a local ignored file if you need real model keys. Do not commit real keys.
2. Start infrastructure only:

```powershell
docker compose -f docker-compose.v2.yml up -d
```

3. Start the full local development runtime:

```powershell
npm run dev
```

`npm run dev` supplies safe local defaults for PostgreSQL, Temporal, Qdrant, MinIO/S3, API, Worker, and Vite. The V2 API listens on `http://127.0.0.1:4770` and Vite proxies `/v2/*` to it. Model providers are configured only through `config/model-providers.local.yaml` or the settings API; a missing local file means external-MCP-only execution.

## Environment

Required local defaults are already provided by `scripts/dev-v2.mjs` and `docker-compose.v2.yml`:

- `DATABASE_URL=postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp`
- `TEMPORAL_ADDRESS=127.0.0.1:7233`
- `QDRANT_URL=http://127.0.0.1:6333`
- `NOVEL_OBJECT_BACKEND=s3`
- `S3_ENDPOINT=http://127.0.0.1:9000`
- `S3_BUCKET=ymcp-novel`

Runtime object storage is fail-closed. `NOVEL_OBJECT_BACKEND` must be explicitly set to `s3` or `file`; S3 requires a complete endpoint, bucket, and credential set, while file storage requires an absolute `NOVEL_OBJECT_ROOT`. The API and Worker bind the selected storage identity to PostgreSQL and refuse to start if another endpoint, bucket, or file root is later used with the same database. They also verify every current final manuscript object before accepting work.

Use `npm run dev`, `npm run novel:v2:api`, or `npm run novel:v2:worker` so both services receive the same local MinIO defaults. Invoking the TypeScript entrypoints directly without an explicit object-store configuration is intentionally rejected.

## HTTP surface

- `GET /health` checks API/PostgreSQL reachability.
- `GET /v2/projects` lists V2 projects.
- `POST /v2/projects` creates or updates a V2 project.
- `POST /v2/projects` accepts an optional versioned `creativeBrief`; omitted briefs remain compatible with premise-only clients.
- Foundation bootstrap defaults to `reviewGate=manual`; core planning sections require the current artifact review plus explicit author confirmation before downstream work unlocks. `reviewGate=none` is reserved for tests/debugging.
- `GET /v2/projects/:projectId` returns project detail plus manuscript document targets.
- `POST /v2/projects/:projectId/documents` creates a target manuscript document.
- `POST /v2/intents` submits a durable intent and starts `novelIntentWorkflow`.
- `GET /v2/runs/:workflowId` returns Temporal plus persisted workflow status.
- `GET /v2/runs/:workflowId/events` returns project-filtered outbox events; `Accept: text/event-stream` streams the same events.
- `POST /v2/commits` is guarded by `CommitService` and requires both current internal and independent review evidence for the artifact fingerprint; chapter workflows also pass applicable blueprint dimensions so missing D1-D5 evidence cannot bypass the final commit check.
- `GET/PUT /v2/model-config` reads or atomically replaces the masked global provider and purpose routing configuration.
- `GET /v2/model-tasks` and the claim/heartbeat/submit/fail routes back external MCP execution without calling a model API.

## Live smoke

With Docker running:

```powershell
docker compose -f docker-compose.v2.yml config --quiet
docker compose -f docker-compose.v2.yml up -d
npm run novel:v2:api
npm run novel:v2:worker
```

Then create a project and chapter target through Web or HTTP, submit a planning/drafting intent, and verify:

- `workflow_runs` contains accepted/running/completed or failed status.
- Outbox contains workflow and blueprint/artifact events for the project.
- Planning intents produce preflight, memory bundle, skill bundle, and execution blueprint records.
- Drafting without configured API providers creates durable external MCP tasks and waits without silently producing empty artifacts.
- A Foundation smoke test must also verify semantic-contract rejection, `review.foundation` evidence with the current artifact fingerprint, and the author-confirmation transition for the five core sections.

## Direct replacement boundary

The old `/v1/projects` runtime, `novelRuntimeClient`, SQLite runtime scripts, and legacy NovelStudio pages are not compatibility targets. Any reintroduction of those names should be treated as a regression unless it appears only in migration notes describing their removal.

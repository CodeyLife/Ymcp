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
- `S3_ENDPOINT=http://127.0.0.1:9000`
- `S3_BUCKET=ymcp-novel`

If `S3_ENDPOINT` / MinIO credentials are missing, `ContentObjectStore` falls back to local `.data/objects` for developer-only runs. Compose-backed V2 development should use MinIO.

## HTTP surface

- `GET /health` checks API/PostgreSQL reachability.
- `GET /v2/projects` lists V2 projects.
- `POST /v2/projects` creates or updates a V2 project.
- `GET /v2/projects/:projectId` returns project detail plus manuscript document targets.
- `POST /v2/projects/:projectId/documents` creates a target manuscript document.
- `POST /v2/intents` submits a durable intent and starts `novelIntentWorkflow`.
- `GET /v2/runs/:workflowId` returns Temporal plus persisted workflow status.
- `GET /v2/runs/:workflowId/events` returns project-filtered outbox events; `Accept: text/event-stream` streams the same events.
- `POST /v2/commits` is guarded by `CommitService` and requires both current internal and independent review evidence for the artifact fingerprint.
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

## Direct replacement boundary

The old `/v1/projects` runtime, `novelRuntimeClient`, SQLite runtime scripts, and legacy NovelStudio pages are not compatibility targets. Any reintroduction of those names should be treated as a regression unless it appears only in migration notes describing their removal.

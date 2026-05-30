# Worker Event Streaming — Design Spec

**Date:** 2026-05-30
**Status:** Approved

## Goal

Add live worker progress observability to the orchestrator's HTTP server. Workers (Docker or ACA Jobs) push structured events and log lines back to the orchestrator as they run. The orchestrator exposes endpoints to list all workers and stream their events in real time. The existing `src/health/server.ts` is replaced with a proper Fastify-based API gateway.

---

## Architecture Overview

Two boundaries communicate via HTTP:

```
Worker container
  └─ docker/lib/events.mjs
       └─ POST /internal/workers/:id/events  (INTERNAL_WORKER_SECRET)
            └─ WorkerRegistry (in-memory, EventEmitter per worker)
                 └─ GET /api/workers              (API_KEY)
                 └─ GET /api/workers/:id/stream   (API_KEY, SSE)
```

The orchestrator is the single API server. No external state store. All worker state is in-memory with 24-hour retention after a worker finishes.

---

## File Structure

### New: `src/api-gateway/`

Replaces `src/health/server.ts` (deleted).

```
src/api-gateway/
  server.ts              — Fastify app factory (buildApp) + startApiServer()
  internal-secret.ts     — singleton: randomBytes(32).toString('hex'), generated once at startup
  worker-registry.ts     — WorkerRegistry class
  routes/
    health.ts            — GET /, /healthz, /readyz  (public)
    webhook.ts           — POST /webhook  (HMAC-verified)
    workers.ts           — GET /api/workers, GET /api/workers/:id/stream  (Bearer API_KEY)
    internal.ts          — POST /internal/workers/:id/events  (Bearer INTERNAL_WORKER_SECRET)
```

### New: `docker/lib/events.mjs`

Best-effort event push helper for worker containers. Reads `ORCHESTRATOR_INTERNAL_URL` and `INTERNAL_WORKER_SECRET` from env. All calls are silent no-ops when `ORCHESTRATOR_INTERNAL_URL` is absent.

### Modified

| File | Change |
|---|---|
| `src/config.ts` | Add `API_KEY` (required), `ORCHESTRATOR_INTERNAL_URL` (optional) |
| `src/job-runner/local-docker.ts` | Inject `ORCHESTRATOR_INTERNAL_URL` + `INTERNAL_WORKER_SECRET` into container |
| `src/job-runner/aca.ts` | Same |
| `src/runner/serve.ts` | Replace `startHealthServer` with `startApiServer`, create registry + secret singletons |
| `src/runner/run-once.ts` | Same (health server is also started there for poll/run-once modes) |
| `src/status.ts` | Remove `WorkerLastStatus`, dead `markWorkerDone*` functions, and `lastWorker` from `AppStatus`; worker state now lives in the registry and is accessible via `/api/workers` |
| `docker/lib/common.mjs` | Update `log()` to also call `emitLog()` |
| `docker/lib/implement.mjs` | Add `emitEvent()` calls at key milestones; wrap top-level in try/finally for `worker.finished` |
| `docker/lib/review.mjs` | Same |
| `env.example` | Add `API_KEY` |
| `docs/azure-setup.md` | Document `API_KEY` as a Key Vault secret |

### New: `bruno/autoworker/`

Git-ignored secrets; Bruno collection pre-populated with all new endpoints.

---

## Data Model

### WorkerEvent

Posted by the worker; stored in registry; streamed via SSE.

```typescript
type WorkerEvent = {
  seq: number;                          // assigned by registry on receipt (monotonic per worker)
  ts: string;                           // ISO timestamp from worker
  type: "lifecycle" | "log";

  // type === "lifecycle"
  event?: string;                       // e.g. "clone.done", "worker.finished"
  data?: Record<string, unknown>;

  // type === "log"
  level?: string;                       // "info" | "warn" | "error" | "debug"
  fields?: Record<string, unknown>;
};
```

### WorkerRecord

```typescript
type WorkerRecord = {
  correlationId: string;
  mode: "implementation" | "pr-review";
  issueUrl: string;
  issue: string;           // "owner/repo#123"
  runner: "local-docker" | "aca";
  startedAt: string;
  finishedAt?: string;
  outcome?: "success" | "failed";
  error?: string;
  events: WorkerEvent[];
  emitter: EventEmitter;   // internal only — never serialised
  expiresAt: number;       // Date.now() + 24h, set when worker.finished received
};
```

### `GET /api/workers` response

```json
{
  "workers": [
    {
      "correlationId": "...",
      "mode": "implementation",
      "issueUrl": "...",
      "issue": "owner/repo#12",
      "runner": "local-docker",
      "startedAt": "2026-05-30T10:00:00.000Z",
      "finishedAt": null,
      "outcome": null,
      "eventCount": 17,
      "active": true
    }
  ]
}
```

Active workers (`finishedAt` absent) sorted first, then finished workers by `startedAt` descending. `emitter` and `expiresAt` are never exposed.

---

## Lifecycle Events

### `implement.mjs`

| Event | Key `data` fields |
|---|---|
| `harness.start` | `ownerRepo`, `issueNum`, `llmModel` |
| `clone.done` | `repoDir` |
| `opencode.start` | `model`, `attempt` |
| `opencode.done` | `exitCode` |
| `grader.start` | `attempt`, `maxIterations` |
| `grader.iteration` | `pass`, `score`, `attempt` |
| `pr.created` | `url`, `branch` |
| `worker.finished` | `outcome`, `error?` |

### `review.mjs`

| Event | Key `data` fields |
|---|---|
| `review.start` | `prUrl`, `branch` |
| `opencode.done` | `exitCode` |
| `review.posted` | `commentUrl` |
| `worker.finished` | `outcome`, `error?` |

`worker.finished` is always the last event emitted (try/finally in harness entry points). The registry marks the record finished and emits `"finished"` on the internal emitter upon receiving it.

---

## Auth & Security

### Three independent auth layers

| Endpoint | Mechanism |
|---|---|
| `GET /`, `/healthz`, `/readyz` | Public |
| `POST /webhook` | HMAC-SHA256 `X-Hub-Signature-256` (unchanged) |
| `GET /api/workers`, `GET /api/workers/:id/stream` | `Authorization: Bearer <API_KEY>` |
| `POST /internal/workers/:id/events` | `Authorization: Bearer <INTERNAL_WORKER_SECRET>` |

### `API_KEY`
- Required config var (`src/config.ts` Zod schema)
- Operator-set; added to `env.example` and Azure Key Vault docs
- Validated in a Fastify `preHandler` hook on all `/api/*` routes
- Constant-time compare (`crypto.timingSafeEqual`) — no timing leak

### `INTERNAL_WORKER_SECRET`
- Generated at process startup: `randomBytes(32).toString('hex')`
- Lives in `src/api-gateway/internal-secret.ts` as a module-level singleton
- Never written to disk or config — ephemeral per process lifetime
- Injected into worker containers as `INTERNAL_WORKER_SECRET` env var by both job runners
- Constant-time compare on `/internal/*` routes

### `ORCHESTRATOR_INTERNAL_URL`
- Optional config var (not a secret)
- Local-docker runner: auto-computes `http://host.docker.internal:{HEALTH_PORT}` when absent
- ACA runner: logs a warning at startup when absent; container receives no URL and event pushing is silently skipped
- Workers treat a missing URL as a no-op — never fail because of it

---

## Fastify Server Structure

### `buildApp(deps)` / `startApiServer(opts)`

```typescript
// Used in tests — returns configured FastifyInstance without listening
export function buildApp(deps: {
  webhookDeps?: WebhookDeps;
  registry: WorkerRegistry;
  cfg: Config;
  internalSecret: string;
}): FastifyInstance

// Used at runtime — calls buildApp then fastify.listen()
export async function startApiServer(opts: { ... }): Promise<FastifyInstance>
```

### Route prefixes and auth

```
healthRoutes    →  no prefix,      no auth
webhookRoutes   →  no prefix,      HMAC (self-contained in handler)
workersRoutes   →  prefix /api,    preHandler: bearerAuth(cfg.API_KEY)
internalRoutes  →  prefix /internal, preHandler: bearerAuth(internalSecret)
```

### SSE (`GET /api/workers/:id/stream`)

1. Set `Content-Type: text/event-stream`, call `reply.hijack()`
2. Replay all buffered events from `record.events`
3. Subscribe `record.emitter.on("event", sendFrame)`
4. Set 15 s heartbeat interval
5. On `record.emitter.once("finished")` → send `stream.closed` frame, cleanup
6. On `req.raw.on("close")` → cleanup (client disconnect)

Each frame: `data: <json>\n\n` with `id: <seq>` for `Last-Event-ID` reconnect support.

### Dependency

```
pnpm add fastify
```

No additional Fastify plugins. SSE implemented via `reply.hijack()` + `reply.raw`.

---

## Bruno Collection

```
bruno/autoworker/
  opencollection.yml
  environments/
    dev.yml            — BASE_URL, API_TOKEN (secret: true)
  health.yml           — GET /healthz  (no auth)
  workers-list.yml     — GET /api/workers  (Bearer {{API_TOKEN}})
  worker-stream.yml    — GET /api/workers/:id/stream  (Bearer {{API_TOKEN}})
```

`bruno/` added to `.gitignore` for secret variables; the directory itself is committed (skeleton only, no secret values).

---

## Health Endpoint Response After Refactor

`GET /healthz` continues to return `AppStatus`, but `lastWorker` is removed. The payload becomes:

```json
{
  "ok": true,
  "status": {
    "processStartedAt": "...",
    "poll": { "startedAt": "...", "finishedAt": "...", "lastOkAt": "...", "lastError": null },
    "webhook": { "enabled": true, "received": 5, "enqueued": 4, "processed": 4, "queueDepth": 0, ... }
  }
}
```

Per-worker detail (start time, outcome, events) is available exclusively via `GET /api/workers` and the SSE stream.

---

## Out of Scope

- Persistence across orchestrator restarts (GitHub labels remain the source of truth)
- WebSocket or long-polling alternatives (SSE is sufficient)
- Per-worker event cap / ring buffer (24 h TTL is the only bound; typical runs produce tens of events)
- GitLab support (tracked separately)

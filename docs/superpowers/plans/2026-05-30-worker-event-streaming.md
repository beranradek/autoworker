# Worker Event Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live worker progress observability: workers push structured events to the orchestrator API; a Fastify-based gateway exposes `GET /api/workers` (list) and `GET /api/workers/:id/stream` (SSE), secured by an `API_KEY` env var.

**Architecture:** Replace the hand-rolled Node `http` server in `src/health/server.ts` with a Fastify app in `src/api-gateway/`. Workers POST events via an auto-generated ephemeral `INTERNAL_WORKER_SECRET`. An in-memory `WorkerRegistry` fans events out to SSE clients and evicts records after 24 h.

**Tech Stack:** Node.js 18+, TypeScript, Fastify 5, Vitest, Bruno (API collection)

---

## File map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `src/api-gateway/worker-registry.ts` | In-memory worker store + EventEmitter fan-out |
| Create | `src/api-gateway/internal-secret.ts` | Ephemeral INTERNAL_WORKER_SECRET singleton |
| Create | `src/api-gateway/routes/health.ts` | Fastify plugin: GET /healthz /readyz / |
| Create | `src/api-gateway/routes/webhook.ts` | Fastify plugin: POST /webhook |
| Create | `src/api-gateway/routes/internal.ts` | Fastify plugin: POST /internal/workers/:id/events |
| Create | `src/api-gateway/routes/workers.ts` | Fastify plugin: GET /api/workers + SSE stream |
| Create | `src/api-gateway/server.ts` | buildApp() + startApiServer() |
| Delete | `src/health/server.ts` | Replaced by api-gateway |
| Modify | `src/config.ts` | Add API_KEY, ORCHESTRATOR_INTERNAL_URL |
| Modify | `src/status.ts` | Remove WorkerLastStatus, lastWorker, markWorkerDone* |
| Modify | `src/job-runner/types.ts` | Add orchestratorInternalUrl?, internalWorkerSecret? |
| Modify | `src/job-runner/local-docker.ts` | Inject two new env vars into container |
| Modify | `src/job-runner/aca.ts` | Inject two new env vars into container |
| Modify | `src/runner/run-once.ts` | buildRunner imports internalWorkerSecret; passes orchUrl |
| Modify | `src/runner/poll.ts` | Replace startHealthServer → startApiServer |
| Modify | `src/runner/serve.ts` | Replace startHealthServer → startApiServer, pass registry |
| Modify | `src/runner/orchestrate.ts` | Accept optional registry, register workers after dispatch |
| Create | `docker/lib/events.mjs` | Worker-side event push helper |
| Modify | `docker/lib/common.mjs` | log() also calls emitLog() |
| Modify | `docker/lib/implement.mjs` | emitEvent() at milestones, try/finally for worker.finished |
| Modify | `docker/lib/review.mjs` | emitEvent() at milestones, try/finally for worker.finished |
| Create | `test/worker-registry.test.ts` | WorkerRegistry unit tests |
| Create | `test/api-gateway.test.ts` | Fastify route integration tests |
| Modify | `test/local-docker-runner.test.ts` | Add tests for new env var injection |
| Modify | `test/config.test.ts` | Add tests for new config vars |
| Create | `env.example` | All env vars with descriptions |
| Modify | `docs/azure-setup.md` | Add API_KEY to Key Vault secrets table |
| Create | `bruno/autoworker/opencollection.yml` | Bruno collection root |
| Create | `bruno/autoworker/environments/dev.yml` | Dev environment with secrets |
| Create | `bruno/autoworker/health.yml` | GET /healthz request |
| Create | `bruno/autoworker/workers-list.yml` | GET /api/workers request |
| Create | `bruno/autoworker/worker-stream.yml` | GET /api/workers/:id/stream request |
| Modify | `.gitignore` | Add bruno/*/environments/ |

---

## Task 1: Install Fastify and create WorkerRegistry

**Files:**
- Run: `pnpm add fastify`
- Create: `src/api-gateway/worker-registry.ts`
- Create: `test/worker-registry.test.ts`

- [ ] **Step 1: Install fastify**

```bash
cd /home/radek/dev/autoworker && pnpm add fastify
```

Expected: `package.json` gains `"fastify": "^5.x.x"` in dependencies.

- [ ] **Step 2: Write failing tests for WorkerRegistry**

Create `test/worker-registry.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WorkerRegistry } from "../src/api-gateway/worker-registry.js";

function makeInput(overrides: Partial<Parameters<WorkerRegistry["register"]>[0]> = {}) {
  return {
    correlationId: "cid-1",
    mode: "implementation" as const,
    issueUrl: "https://github.com/o/r/issues/1",
    issue: "o/r#1",
    runner: "local-docker" as const,
    ...overrides
  };
}

describe("WorkerRegistry", () => {
  let registry: WorkerRegistry;

  beforeEach(() => { registry = new WorkerRegistry(); });
  afterEach(() => { registry.destroy(); });

  it("register returns a record with correct fields", () => {
    const rec = registry.register(makeInput());
    expect(rec.correlationId).toBe("cid-1");
    expect(rec.mode).toBe("implementation");
    expect(rec.issue).toBe("o/r#1");
    expect(rec.runner).toBe("local-docker");
    expect(rec.finishedAt).toBeUndefined();
    expect(rec.events).toHaveLength(0);
  });

  it("get returns the registered record", () => {
    registry.register(makeInput());
    expect(registry.get("cid-1")).toBeDefined();
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("appendEvent assigns monotonic seq and returns the event", () => {
    registry.register(makeInput());
    const ev1 = registry.appendEvent("cid-1", { type: "log", ts: "t1", level: "info", event: "a", fields: {} });
    const ev2 = registry.appendEvent("cid-1", { type: "log", ts: "t2", level: "info", event: "b", fields: {} });
    expect(ev1?.seq).toBe(1);
    expect(ev2?.seq).toBe(2);
  });

  it("appendEvent emits 'event' on the record emitter", () => {
    registry.register(makeInput());
    const received: unknown[] = [];
    registry.get("cid-1")!.emitter.on("event", (e) => received.push(e));
    registry.appendEvent("cid-1", { type: "log", ts: "t1", level: "info", event: "x", fields: {} });
    expect(received).toHaveLength(1);
  });

  it("appendEvent returns undefined for unknown correlationId", () => {
    expect(registry.appendEvent("no-such", { type: "log", ts: "t", level: "info", event: "x", fields: {} })).toBeUndefined();
  });

  it("worker.finished event marks record as finished and sets expiresAt", () => {
    registry.register(makeInput());
    registry.appendEvent("cid-1", {
      type: "lifecycle", ts: "t1", event: "worker.finished", data: { outcome: "success" }
    });
    const rec = registry.get("cid-1")!;
    expect(rec.finishedAt).toBeDefined();
    expect(rec.outcome).toBe("success");
    expect(rec.expiresAt).toBeGreaterThan(Date.now());
  });

  it("worker.finished with failed outcome captures error", () => {
    registry.register(makeInput());
    registry.appendEvent("cid-1", {
      type: "lifecycle", ts: "t1", event: "worker.finished", data: { outcome: "failed", error: "boom" }
    });
    const rec = registry.get("cid-1")!;
    expect(rec.outcome).toBe("failed");
    expect(rec.error).toBe("boom");
  });

  it("worker.finished emits 'finished' on the record emitter", () => {
    registry.register(makeInput());
    let emitted = false;
    registry.get("cid-1")!.emitter.once("finished", () => { emitted = true; });
    registry.appendEvent("cid-1", {
      type: "lifecycle", ts: "t1", event: "worker.finished", data: { outcome: "success" }
    });
    expect(emitted).toBe(true);
  });

  it("list returns active workers before finished workers", () => {
    registry.register(makeInput({ correlationId: "a", issueUrl: "u1", issue: "o/r#1" }));
    registry.register(makeInput({ correlationId: "b", issueUrl: "u2", issue: "o/r#2" }));
    registry.appendEvent("a", { type: "lifecycle", ts: "t", event: "worker.finished", data: { outcome: "success" } });
    const list = registry.list();
    expect(list[0].correlationId).toBe("b");  // active first
    expect(list[1].correlationId).toBe("a");  // finished second
    expect(list[0].active).toBe(true);
    expect(list[1].active).toBe(false);
  });

  it("list summary has eventCount but no emitter", () => {
    registry.register(makeInput());
    registry.appendEvent("cid-1", { type: "log", ts: "t", level: "info", event: "x", fields: {} });
    const [s] = registry.list();
    expect(s.eventCount).toBe(1);
    expect("emitter" in s).toBe(false);
    expect("expiresAt" in s).toBe(false);
  });

  it("evict removes records past their expiresAt", () => {
    registry.register(makeInput());
    registry.appendEvent("cid-1", { type: "lifecycle", ts: "t", event: "worker.finished", data: { outcome: "success" } });
    // Force expiry
    registry.get("cid-1")!.expiresAt = Date.now() - 1;
    registry.evictNow();
    expect(registry.get("cid-1")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd /home/radek/dev/autoworker && pnpm test test/worker-registry.test.ts
```

Expected: fail with "Cannot find module '../src/api-gateway/worker-registry.js'"

- [ ] **Step 4: Implement WorkerRegistry**

Create `src/api-gateway/worker-registry.ts`:

```typescript
import { EventEmitter } from "node:events";

export type WorkerMode = "implementation" | "pr-review";

export type WorkerEvent = {
  seq: number;
  ts: string;
  type: "lifecycle" | "log";
  event?: string;
  data?: Record<string, unknown>;
  level?: string;
  fields?: Record<string, unknown>;
};

export type WorkerRecord = {
  correlationId: string;
  mode: WorkerMode;
  issueUrl: string;
  issue: string;
  runner: "local-docker" | "aca";
  startedAt: string;
  finishedAt?: string;
  outcome?: "success" | "failed";
  error?: string;
  events: WorkerEvent[];
  emitter: EventEmitter;
  expiresAt?: number;
};

export type WorkerSummary = {
  correlationId: string;
  mode: WorkerMode;
  issueUrl: string;
  issue: string;
  runner: "local-docker" | "aca";
  startedAt: string;
  finishedAt?: string;
  outcome?: "success" | "failed";
  error?: string;
  eventCount: number;
  active: boolean;
};

export type RegisterInput = {
  correlationId: string;
  mode: WorkerMode;
  issueUrl: string;
  issue: string;
  runner: "local-docker" | "aca";
};

const RETENTION_MS = 24 * 60 * 60 * 1000;
const EVICTION_INTERVAL_MS = 5 * 60 * 1000;

export class WorkerRegistry {
  private readonly records = new Map<string, WorkerRecord>();
  private evictionTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.evictionTimer = setInterval(() => this.evictNow(), EVICTION_INTERVAL_MS);
    this.evictionTimer.unref?.();
  }

  register(input: RegisterInput): WorkerRecord {
    const record: WorkerRecord = {
      correlationId: input.correlationId,
      mode: input.mode,
      issueUrl: input.issueUrl,
      issue: input.issue,
      runner: input.runner,
      startedAt: new Date().toISOString(),
      events: [],
      emitter: new EventEmitter()
    };
    this.records.set(input.correlationId, record);
    return record;
  }

  get(correlationId: string): WorkerRecord | undefined {
    return this.records.get(correlationId);
  }

  appendEvent(correlationId: string, raw: Omit<WorkerEvent, "seq">): WorkerEvent | undefined {
    const record = this.records.get(correlationId);
    if (!record) return undefined;

    const event: WorkerEvent = { ...raw, seq: record.events.length + 1 };
    record.events.push(event);
    record.emitter.emit("event", event);

    if (raw.type === "lifecycle" && raw.event === "worker.finished") {
      record.finishedAt = new Date().toISOString();
      record.outcome = (raw.data?.outcome as string) === "success" ? "success" : "failed";
      if (raw.data?.error) record.error = raw.data.error as string;
      record.expiresAt = Date.now() + RETENTION_MS;
      record.emitter.emit("finished");
    }

    return event;
  }

  list(): WorkerSummary[] {
    const all = Array.from(this.records.values());
    const toSummary = (r: WorkerRecord): WorkerSummary => ({
      correlationId: r.correlationId,
      mode: r.mode,
      issueUrl: r.issueUrl,
      issue: r.issue,
      runner: r.runner,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      outcome: r.outcome,
      error: r.error,
      eventCount: r.events.length,
      active: !r.finishedAt
    });
    const active = all.filter((r) => !r.finishedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const finished = all.filter((r) => r.finishedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return [...active, ...finished].map(toSummary);
  }

  evictNow(): void {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt != null && now > record.expiresAt) {
        record.emitter.removeAllListeners();
        this.records.delete(id);
      }
    }
  }

  destroy(): void {
    if (this.evictionTimer) clearInterval(this.evictionTimer);
    for (const record of this.records.values()) {
      record.emitter.removeAllListeners();
    }
    this.records.clear();
  }
}

export const workerRegistry = new WorkerRegistry();
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /home/radek/dev/autoworker && pnpm test test/worker-registry.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Typecheck**

```bash
cd /home/radek/dev/autoworker && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /home/radek/dev/autoworker && pnpm build && git add src/api-gateway/worker-registry.ts test/worker-registry.test.ts package.json pnpm-lock.yaml && git commit -m "feat: add WorkerRegistry + fastify dependency"
```

---

## Task 2: internal-secret module

**Files:**
- Create: `src/api-gateway/internal-secret.ts`
- Create: `test/internal-secret.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/internal-secret.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { internalWorkerSecret } from "../src/api-gateway/internal-secret.js";

describe("internalWorkerSecret", () => {
  it("is a 64-character hex string", () => {
    expect(internalWorkerSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is consistent across imports (module singleton)", async () => {
    const { internalWorkerSecret: same } = await import("../src/api-gateway/internal-secret.js");
    expect(internalWorkerSecret).toBe(same);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/radek/dev/autoworker && pnpm test test/internal-secret.test.ts
```

Expected: fail with module not found.

- [ ] **Step 3: Implement**

Create `src/api-gateway/internal-secret.ts`:

```typescript
import { randomBytes } from "node:crypto";

export const internalWorkerSecret: string = randomBytes(32).toString("hex");
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/radek/dev/autoworker && pnpm test test/internal-secret.test.ts
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
cd /home/radek/dev/autoworker && pnpm build && git add src/api-gateway/internal-secret.ts test/internal-secret.test.ts && git commit -m "feat: add internal-secret singleton"
```

---

## Task 3: Add API_KEY and ORCHESTRATOR_INTERNAL_URL to config

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/config.test.ts` (append after existing tests):

```typescript
  it("accepts API_KEY in config", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        DRY_RUN: "true",
        API_KEY: "my-secret-api-key"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.API_KEY).toBe("my-secret-api-key");
      }
    );
  });

  it("accepts ORCHESTRATOR_INTERNAL_URL in config", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        DRY_RUN: "true",
        API_KEY: "key",
        ORCHESTRATOR_INTERNAL_URL: "http://host.docker.internal:8080"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.ORCHESTRATOR_INTERNAL_URL).toBe("http://host.docker.internal:8080");
      }
    );
  });

  it("ORCHESTRATOR_INTERNAL_URL defaults to undefined when not set", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        DRY_RUN: "true",
        API_KEY: "key"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.ORCHESTRATOR_INTERNAL_URL).toBeUndefined();
      }
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/radek/dev/autoworker && pnpm test test/config.test.ts
```

Expected: new tests fail with "cfg.API_KEY is undefined" etc.

- [ ] **Step 3: Add config vars**

In `src/config.ts`, add these two lines to the Zod schema object (after `GITHUB_WEBHOOK_SECRET`):

```typescript
  API_KEY: z.string().optional(),
  ORCHESTRATOR_INTERNAL_URL: z.string().optional(),
```

Also update the `Config` type export at the bottom — the `Omit<RawConfig, "GITHUB_TOKEN"> & { GITHUB_TOKEN: string }` already includes all optional fields, so no change needed there.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/radek/dev/autoworker && pnpm test test/config.test.ts
```

Expected: all pass.

- [ ] **Step 5: Typecheck**

```bash
cd /home/radek/dev/autoworker && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /home/radek/dev/autoworker && pnpm build && git add src/config.ts test/config.test.ts && git commit -m "feat(config): add API_KEY and ORCHESTRATOR_INTERNAL_URL"
```

---

## Task 4: Health and Webhook Fastify route plugins

**Files:**
- Create: `src/api-gateway/routes/health.ts`
- Create: `src/api-gateway/routes/webhook.ts`
- Create: `test/api-gateway.test.ts` (partial — health + webhook tests)

The tests in this task use `buildApp` from Task 6. Write the test file now but it will only compile after Task 6. Focus on making the units correct; full compilation test comes in Task 6.

- [ ] **Step 1: Create health route plugin**

Create `src/api-gateway/routes/health.ts`:

```typescript
import type { FastifyPluginAsync } from "fastify";
import { getStatus } from "../../status.js";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  const handler = async () => ({ ok: true, status: getStatus() });
  fastify.get("/", handler);
  fastify.get("/healthz", handler);
  fastify.get("/readyz", handler);
};
```

- [ ] **Step 2: Create webhook route plugin**

The webhook plugin receives the raw request body as a `Buffer` so HMAC verification can run on the unmodified bytes. It replicates all logic from `src/health/server.ts`'s `handleWebhook`.

Create `src/api-gateway/routes/webhook.ts`:

```typescript
import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { log } from "../../log.js";
import { markWebhookEnqueued, markWebhookError, markWebhookReceived } from "../../status.js";
import { parseWebhookEvent } from "../../webhook/events.js";
import { verifySignature } from "../../webhook/verify.js";
import type { FifoQueue } from "../../webhook/queue.js";
import type { RepoRef } from "../../github/types.js";

export type WebhookDeps = {
  secret: string | undefined;
  queue: FifoQueue;
  repos: RepoRef[];
};

type WebhookPluginOpts = { deps: WebhookDeps };

export const webhookRoutes: FastifyPluginAsync<WebhookPluginOpts> = async (fastify, opts) => {
  const { deps } = opts;

  // Parse body as raw Buffer so we can HMAC-verify the original bytes.
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  fastify.post<{ Body: Buffer }>("/webhook", async (req: FastifyRequest<{ Body: Buffer }>, reply: FastifyReply) => {
    const eventType = (req.headers["x-github-event"] as string | undefined) ?? "unknown";

    if (!deps.secret) {
      log("warn", "webhook.disabled", { eventType });
      return reply.code(401).send({ ok: false, error: "webhook_disabled" });
    }

    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifySignature(deps.secret, req.body, signature)) {
      log("warn", "webhook.invalid_signature", { eventType });
      return reply.code(401).send({ ok: false, error: "invalid_signature" });
    }

    markWebhookReceived(eventType);

    if (eventType === "ping") {
      return reply.code(200).send({ ok: true, pong: true });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      log("warn", "webhook.invalid_json", { eventType });
      return reply.code(400).send({ ok: false, error: "invalid_json" });
    }

    const parsed = parseWebhookEvent(eventType, payload);
    if (!parsed) {
      return reply.code(202).send({ ok: true, queued: false, reason: "ignored_event" });
    }

    const repo = deps.repos.find(
      (r) => `${r.owner}/${r.repo}`.toLowerCase() === parsed.repoFullName.toLowerCase()
    );
    if (!repo) {
      log("warn", "webhook.repo_not_configured", { repo: parsed.repoFullName });
      return reply.code(202).send({ ok: true, queued: false, reason: "repo_not_configured" });
    }

    const repoKey = `${repo.owner}/${repo.repo}`;
    const queued = deps.queue.enqueue({
      repo,
      repoKey,
      reason: parsed.summary,
      enqueuedAt: new Date().toISOString()
    });
    if (queued) markWebhookEnqueued(deps.queue.depth);

    log("info", "webhook.received", { repo: repoKey, event: parsed.summary, queued });
    return reply.code(202).send({ ok: true, queued });
  });
};
```

- [ ] **Step 3: Typecheck these two files**

```bash
cd /home/radek/dev/autoworker && pnpm typecheck
```

Expected: no errors on the two new route files (other files may still have errors from tasks not yet done — that is expected).

- [ ] **Step 4: Commit**

```bash
cd /home/radek/dev/autoworker && pnpm build && git add src/api-gateway/routes/health.ts src/api-gateway/routes/webhook.ts && git commit -m "feat(api-gateway): health and webhook Fastify route plugins"
```

---

## Task 5: Internal and Workers Fastify route plugins

**Files:**
- Create: `src/api-gateway/routes/internal.ts`
- Create: `src/api-gateway/routes/workers.ts`

- [ ] **Step 1: Create shared auth helper**

Create `src/api-gateway/auth.ts`:

```typescript
import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

function pad(a: string, b: string): [Buffer, Buffer] {
  const len = Math.max(Buffer.byteLength(a), Buffer.byteLength(b));
  const ba = Buffer.alloc(len);
  const bb = Buffer.alloc(len);
  ba.write(a);
  bb.write(b);
  return [ba, bb];
}

export function safeCompare(a: string, b: string): boolean {
  const [ba, bb] = pad(a, b);
  return timingSafeEqual(ba, bb);
}

export function makeBearerAuth(expected: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = (req.headers.authorization as string | undefined) ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!safeCompare(token, expected)) {
      return reply.code(401).send({ ok: false, error: "unauthorized" }) as unknown as void;
    }
  };
}
```

- [ ] **Step 2: Create internal route plugin**

Create `src/api-gateway/routes/internal.ts`:

```typescript
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { makeBearerAuth } from "../auth.js";
import type { WorkerRegistry } from "../worker-registry.js";

type InternalPluginOpts = { registry: WorkerRegistry; internalSecret: string };

type EventBody = {
  type: "lifecycle" | "log";
  ts: string;
  event?: string;
  data?: Record<string, unknown>;
  level?: string;
  fields?: Record<string, unknown>;
};

export const internalRoutes: FastifyPluginAsync<InternalPluginOpts> = async (fastify, opts) => {
  const { registry, internalSecret } = opts;

  fastify.addHook("preHandler", makeBearerAuth(internalSecret));

  fastify.post<{ Params: { id: string }; Body: EventBody }>(
    "/workers/:id/events",
    async (req: FastifyRequest<{ Params: { id: string }; Body: EventBody }>, reply: FastifyReply) => {
      const { id } = req.params;
      const { type, ts, event, data, level, fields } = req.body ?? {};

      if (!type || !ts) {
        return reply.code(400).send({ ok: false, error: "missing type or ts" });
      }

      const appended = registry.appendEvent(id, { type, ts, event, data, level, fields });
      if (!appended) {
        return reply.code(404).send({ ok: false, error: "worker_not_found" });
      }

      return reply.code(202).send({ ok: true, seq: appended.seq });
    }
  );
};
```

- [ ] **Step 3: Create workers route plugin (list + SSE)**

Create `src/api-gateway/routes/workers.ts`:

```typescript
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { makeBearerAuth } from "../auth.js";
import type { WorkerRegistry, WorkerEvent } from "../worker-registry.js";

type WorkersPluginOpts = { registry: WorkerRegistry; apiKey: string };

function sendFrame(raw: NodeJS.WritableStream, data: unknown): void {
  const json = JSON.stringify(data);
  // Include id only for WorkerEvent objects that have a seq
  const seq = (data as WorkerEvent).seq;
  const idLine = typeof seq === "number" ? `id: ${seq}\n` : "";
  raw.write(`${idLine}data: ${json}\n\n`);
}

export const workersRoutes: FastifyPluginAsync<WorkersPluginOpts> = async (fastify, opts) => {
  const { registry, apiKey } = opts;

  fastify.addHook("preHandler", makeBearerAuth(apiKey));

  fastify.get("/workers", async (_req, reply) => {
    return reply.send({ workers: registry.list() });
  });

  fastify.get<{ Params: { id: string } }>(
    "/workers/:id/stream",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const record = registry.get(req.params.id);
      if (!record) {
        return reply.code(404).send({ ok: false, error: "worker_not_found" });
      }

      reply.hijack();
      const raw = reply.raw;
      raw.setHeader("Content-Type", "text/event-stream");
      raw.setHeader("Cache-Control", "no-cache");
      raw.setHeader("Connection", "keep-alive");
      raw.writeHead(200);

      // Replay buffered events
      for (const ev of record.events) sendFrame(raw, ev);

      // Worker already finished — close immediately after replay
      if (record.finishedAt) {
        sendFrame(raw, { type: "stream.closed", reason: "worker_finished" });
        raw.end();
        return;
      }

      // Subscribe for live events
      const onEvent = (ev: WorkerEvent) => sendFrame(raw, ev);
      record.emitter.on("event", onEvent);

      const onFinished = () => {
        sendFrame(raw, { type: "stream.closed", reason: "worker_finished" });
        cleanup();
      };
      record.emitter.once("finished", onFinished);

      const heartbeat = setInterval(() => sendFrame(raw, { type: "heartbeat" }), 15_000);

      function cleanup() {
        clearInterval(heartbeat);
        record.emitter.off("event", onEvent);
        record.emitter.off("finished", onFinished);
        raw.end();
      }

      req.raw.on("close", cleanup);
    }
  );
};
```

- [ ] **Step 4: Typecheck**

```bash
cd /home/radek/dev/autoworker && pnpm typecheck
```

Expected: no errors on the new files.

- [ ] **Step 5: Commit**

```bash
cd /home/radek/dev/autoworker && pnpm build && git add src/api-gateway/auth.ts src/api-gateway/routes/internal.ts src/api-gateway/routes/workers.ts && git commit -m "feat(api-gateway): internal and workers route plugins"
```

---

## Task 6: buildApp + startApiServer, delete health/server.ts, update poll.ts

**Files:**
- Create: `src/api-gateway/server.ts`
- Delete: `src/health/server.ts`
- Modify: `src/runner/poll.ts`
- Create: `test/api-gateway.test.ts`

- [ ] **Step 1: Write API gateway tests**

Create `test/api-gateway.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/api-gateway/server.js";
import { WorkerRegistry } from "../src/api-gateway/worker-registry.js";

const API_KEY = "test-api-key";
const INTERNAL_SECRET = "test-internal-secret";

function makeApp(registry: WorkerRegistry) {
  return buildApp({ registry, apiKey: API_KEY, internalSecret: INTERNAL_SECRET });
}

describe("GET /healthz", () => {
  it("returns 200 with ok: true (no auth required)", async () => {
    const registry = new WorkerRegistry();
    const app = makeApp(registry);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    registry.destroy();
  });
});

describe("GET /api/workers", () => {
  let registry: WorkerRegistry;
  beforeEach(() => { registry = new WorkerRegistry(); });
  afterEach(() => { registry.destroy(); });

  it("returns 401 without Authorization header", async () => {
    const app = makeApp(registry);
    const res = await app.inject({ method: "GET", url: "/api/workers" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 with wrong bearer token", async () => {
    const app = makeApp(registry);
    const res = await app.inject({ method: "GET", url: "/api/workers", headers: { authorization: "Bearer wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with correct bearer token", async () => {
    const app = makeApp(registry);
    const res = await app.inject({ method: "GET", url: "/api/workers", headers: { authorization: `Bearer ${API_KEY}` } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ workers: [] });
  });

  it("includes registered workers in the list", async () => {
    registry.register({ correlationId: "c1", mode: "implementation", issueUrl: "u", issue: "o/r#1", runner: "local-docker" });
    const app = makeApp(registry);
    const res = await app.inject({ method: "GET", url: "/api/workers", headers: { authorization: `Bearer ${API_KEY}` } });
    const body = JSON.parse(res.body);
    expect(body.workers).toHaveLength(1);
    expect(body.workers[0].correlationId).toBe("c1");
    expect(body.workers[0].active).toBe(true);
  });
});

describe("POST /internal/workers/:id/events", () => {
  let registry: WorkerRegistry;
  beforeEach(() => { registry = new WorkerRegistry(); });
  afterEach(() => { registry.destroy(); });

  it("returns 401 without Authorization header", async () => {
    const app = makeApp(registry);
    const res = await app.inject({
      method: "POST", url: "/internal/workers/c1/events",
      headers: { "content-type": "application/json" },
      payload: { type: "log", ts: "t", level: "info", event: "x", fields: {} }
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for unknown worker", async () => {
    const app = makeApp(registry);
    const res = await app.inject({
      method: "POST", url: "/internal/workers/no-such/events",
      headers: { authorization: `Bearer ${INTERNAL_SECRET}`, "content-type": "application/json" },
      payload: { type: "log", ts: "t", level: "info", event: "x", fields: {} }
    });
    expect(res.statusCode).toBe(404);
  });

  it("appends event and returns seq for known worker", async () => {
    registry.register({ correlationId: "c1", mode: "implementation", issueUrl: "u", issue: "o/r#1", runner: "local-docker" });
    const app = makeApp(registry);
    const res = await app.inject({
      method: "POST", url: "/internal/workers/c1/events",
      headers: { authorization: `Bearer ${INTERNAL_SECRET}`, "content-type": "application/json" },
      payload: { type: "log", ts: "2026-01-01T00:00:00Z", level: "info", event: "harness.start", fields: {} }
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, seq: 1 });
    expect(registry.get("c1")!.events).toHaveLength(1);
  });
});

describe("GET /api/workers/:id/stream", () => {
  let registry: WorkerRegistry;
  beforeEach(() => { registry = new WorkerRegistry(); });
  afterEach(() => { registry.destroy(); });

  it("returns 401 without auth", async () => {
    const app = makeApp(registry);
    const res = await app.inject({ method: "GET", url: "/api/workers/c1/stream" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for unknown worker", async () => {
    const app = makeApp(registry);
    const res = await app.inject({
      method: "GET", url: "/api/workers/no-such/stream",
      headers: { authorization: `Bearer ${API_KEY}` }
    });
    expect(res.statusCode).toBe(404);
  });

  it("streams buffered events and closes for a finished worker", async () => {
    registry.register({ correlationId: "c1", mode: "implementation", issueUrl: "u", issue: "o/r#1", runner: "local-docker" });
    registry.appendEvent("c1", { type: "lifecycle", ts: "t1", event: "harness.start", data: {} });
    registry.appendEvent("c1", { type: "lifecycle", ts: "t2", event: "worker.finished", data: { outcome: "success" } });

    const app = makeApp(registry);
    const res = await app.inject({
      method: "GET", url: "/api/workers/c1/stream",
      headers: { authorization: `Bearer ${API_KEY}` }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.payload).toContain('"event":"harness.start"');
    expect(res.payload).toContain('"event":"worker.finished"');
    expect(res.payload).toContain('"reason":"worker_finished"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/radek/dev/autoworker && pnpm test test/api-gateway.test.ts
```

Expected: fail with "Cannot find module '../src/api-gateway/server.js'"

- [ ] **Step 3: Create buildApp + startApiServer**

Create `src/api-gateway/server.ts`:

```typescript
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { getConfig } from "../config.js";
import { log } from "../log.js";
import { healthRoutes } from "./routes/health.js";
import { webhookRoutes, type WebhookDeps } from "./routes/webhook.js";
import { workersRoutes } from "./routes/workers.js";
import { internalRoutes } from "./routes/internal.js";
import type { WorkerRegistry } from "./worker-registry.js";

export type { WebhookDeps };

export type BuildAppDeps = {
  webhookDeps?: WebhookDeps;
  registry: WorkerRegistry;
  apiKey: string;
  internalSecret: string;
};

export function buildApp(deps: BuildAppDeps): FastifyInstance {
  const fastify = Fastify({ logger: false });

  fastify.register(healthRoutes);

  if (deps.webhookDeps) {
    fastify.register(webhookRoutes, { deps: deps.webhookDeps });
  }

  fastify.register(workersRoutes, { prefix: "/api", registry: deps.registry, apiKey: deps.apiKey });
  fastify.register(internalRoutes, { prefix: "/internal", registry: deps.registry, internalSecret: deps.internalSecret });

  return fastify;
}

export async function startApiServer(opts: {
  webhookDeps?: WebhookDeps;
  registry: WorkerRegistry;
  internalSecret: string;
}): Promise<FastifyInstance> {
  const cfg = getConfig();
  const apiKey = cfg.API_KEY ?? "";
  if (!apiKey) {
    log("warn", "api_server.no_api_key", { note: "API_KEY is not set — /api/* endpoints are accessible without auth" });
  }

  const app = buildApp({
    webhookDeps: opts.webhookDeps,
    registry: opts.registry,
    apiKey,
    internalSecret: opts.internalSecret
  });

  await app.listen({ host: cfg.HEALTH_HOST, port: cfg.HEALTH_PORT });
  log("info", "api_server.start", { host: cfg.HEALTH_HOST, port: cfg.HEALTH_PORT });
  return app;
}
```

- [ ] **Step 4: Run API gateway tests**

```bash
cd /home/radek/dev/autoworker && pnpm test test/api-gateway.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Update poll.ts to use startApiServer**

Replace the content of `src/runner/poll.ts` with:

```typescript
import { getConfig } from "../config.js";
import { log } from "../log.js";
import { startApiServer } from "../api-gateway/server.js";
import { internalWorkerSecret } from "../api-gateway/internal-secret.js";
import { workerRegistry } from "../api-gateway/worker-registry.js";
import { markPollDoneError, markPollDoneOk, markPollStart } from "../status.js";
import { isWithinWorkHours, secondsUntilNextWorkWindow } from "../schedule/work-hours.js";
import { runOnce } from "./run-once.js";
import type { Mutex } from "./lock.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function pollLoop(opts: { lock?: Mutex } = {}): Promise<void> {
  const cfg = getConfig();
  log("info", "poll.loop_start", { intervalSeconds: cfg.POLL_INTERVAL_SECONDS });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const inWorkHours = isWithinWorkHours(new Date(), {
        timeZone: cfg.WORK_HOURS_TZ,
        startHour: cfg.WORK_HOURS_START,
        endHour: cfg.WORK_HOURS_END
      });

      if (!inWorkHours) {
        const secondsUntil = secondsUntilNextWorkWindow(new Date(), {
          timeZone: cfg.WORK_HOURS_TZ,
          startHour: cfg.WORK_HOURS_START,
          endHour: cfg.WORK_HOURS_END
        });
        const sleepSeconds = Math.min(Math.max(secondsUntil, 60), 15 * 60);
        log("info", "poll.outside_work_hours", {
          timeZone: cfg.WORK_HOURS_TZ,
          startHour: cfg.WORK_HOURS_START,
          endHour: cfg.WORK_HOURS_END,
          sleepSeconds
        });
        await sleep(sleepSeconds * 1000);
        continue;
      }

      markPollStart();
      await (opts.lock ? opts.lock.run(() => runOnce()) : runOnce());
      markPollDoneOk();
    } catch (err) {
      log("error", "poll.loop_error", { error: String(err) });
      markPollDoneError(err);
    }
    await sleep(cfg.POLL_INTERVAL_SECONDS * 1000);
  }
}

export async function pollForever(): Promise<void> {
  await startApiServer({ registry: workerRegistry, internalSecret: internalWorkerSecret });
  await pollLoop();
}
```

- [ ] **Step 6: Delete health/server.ts**

```bash
cd /home/radek/dev/autoworker && rm src/health/server.ts
```

- [ ] **Step 7: Typecheck (expect errors in serve.ts — to be fixed in Task 8)**

```bash
cd /home/radek/dev/autoworker && pnpm typecheck 2>&1 | grep -v "serve.ts" | head -20
```

Expected: errors only in `src/runner/serve.ts` (which still imports from the deleted file). All other files clean.

- [ ] **Step 8: Commit**

```bash
cd /home/radek/dev/autoworker && pnpm build && git add src/api-gateway/server.ts test/api-gateway.test.ts src/runner/poll.ts && git rm src/health/server.ts && git commit -m "feat(api-gateway): buildApp + startApiServer, replace health/server.ts"
```

---

## Task 7: Update serve.ts and status.ts

**Files:**
- Modify: `src/runner/serve.ts`
- Modify: `src/status.ts`

- [ ] **Step 1: Update serve.ts**

Replace `src/runner/serve.ts` with:

```typescript
import { getConfig } from "../config.js";
import { log } from "../log.js";
import { createGitHubClient } from "../github/client.js";
import { GitHubIssueService } from "../issues/github-service.js";
import { startApiServer } from "../api-gateway/server.js";
import { internalWorkerSecret } from "../api-gateway/internal-secret.js";
import { workerRegistry } from "../api-gateway/worker-registry.js";
import {
  markWebhookError,
  markWebhookProcessed,
  setQueueDepth,
  setWebhookEnabled
} from "../status.js";
import { FifoQueue } from "../webhook/queue.js";
import { Mutex } from "./lock.js";
import { buildRunner, parseRepos, validateAuthIfNeeded } from "./run-once.js";
import { pollLoop } from "./poll.js";
import { runOrchestration } from "./orchestrate.js";
import type { Config } from "../config.js";
import type { RepoConfig } from "../repos.js";
import type { Octokit } from "@octokit/rest";
import type { JobRunner } from "../job-runner/types.js";

async function consumeWebhooks(
  queue: FifoQueue,
  octokit: Octokit,
  runner: JobRunner,
  cfg: Config,
  lock: Mutex,
  repoConfigs: import("../repos.js").RepoConfig[]
): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await queue.take();
    setQueueDepth(queue.depth);
    log("info", "webhook.process_start", { repo: job.repoKey, reason: job.reason });
    try {
      const service = new GitHubIssueService(octokit, job.repo, cfg);
      // Derive steps from parsed repo config; fall back to impl+review if not found.
      const repoCfg = repoConfigs.find((r) => `${r.owner}/${r.repo}` === job.repoKey);
      const steps = repoCfg?.steps ?? { impl: true, review: true, merge: false };
      await lock.run(() => runOrchestration(service, runner, cfg, job.repoKey, steps, workerRegistry));
      markWebhookProcessed(job.repoKey, queue.depth);
      log("info", "webhook.process_done", { repo: job.repoKey });
    } catch (err) {
      markWebhookError(err);
      log("error", "webhook.process_error", { repo: job.repoKey, error: String(err) });
    }
  }
}

export async function serve(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.GITHUB_WEBHOOK_SECRET) {
    log("warn", "serve.no_webhook_secret", {
      message: "GITHUB_WEBHOOK_SECRET is not set — webhook endpoint is disabled (returns 401); polling still runs"
    });
  }

  const octokit = createGitHubClient(cfg.GITHUB_TOKEN);
  const repos = parseRepos(cfg);
  validateAuthIfNeeded(cfg);
  const runner = buildRunner(cfg);
  const queue = new FifoQueue();
  const lock = new Mutex();

  setWebhookEnabled(true);

  await startApiServer({
    webhookDeps: { secret: cfg.GITHUB_WEBHOOK_SECRET, queue, repos },
    registry: workerRegistry,
    internalSecret: internalWorkerSecret
  });

  log("info", "serve.start", {
    repos: repos.map((r) => `${r.owner}/${r.repo}`),
    webhookPath: "/webhook",
    safetyPollIntervalSeconds: cfg.POLL_INTERVAL_SECONDS
  });

  const repoConfigs = parseRepos(cfg);
  await Promise.race([consumeWebhooks(queue, octokit, runner, cfg, lock, repoConfigs), pollLoop({ lock })]);
}
```

Note: `job.steps` is added to the queue job type in a later task. For now this compiles if `steps` is optional on the job type. Check what `FifoQueue` / `WebhookJob` currently looks like — if it doesn't have `steps`, pass `{ impl: true, review: true, merge: false }` as a fallback until Task 8 adds the field.

Actually, looking at the existing code, `runOrchestration` currently takes `steps: RepoSteps` as the 5th param (added in the CLAUDE.md update). But `consumeWebhooks` currently calls it without steps. Let me check the current serve.ts call... The original serve.ts calls `runOrchestration(service, runner, cfg, job.repoKey)` — but the updated orchestrate.ts now requires `steps`. This is an existing issue to reconcile.

For this task, pass a hardcoded default steps until the webhook queue includes repo steps:

```typescript
await lock.run(() => runOrchestration(service, runner, cfg, job.repoKey, { impl: true, review: true, merge: false }, workerRegistry));
```

- [ ] **Step 2: Remove dead code from status.ts**

Edit `src/status.ts`. Remove:
1. The `WorkerLastStatus` type export
2. The `lastWorker` field from `AppStatus`
3. The `markWorkerStart` function
4. The `markWorkerDoneOk` function  
5. The `markWorkerDoneError` function

The updated file content for `src/status.ts`:

```typescript
export type PollStatus = {
  startedAt?: string;
  finishedAt?: string;
  lastOkAt?: string;
  lastError?: string;
};

export type WebhookStatus = {
  enabled: boolean;
  received: number;
  enqueued: number;
  processed: number;
  queueDepth: number;
  lastEventType?: string;
  lastEventAt?: string;
  lastProcessedRepo?: string;
  lastProcessedAt?: string;
  lastError?: string;
};

export type AppStatus = {
  processStartedAt: string;
  poll: PollStatus;
  webhook?: WebhookStatus;
};

const state: AppStatus = {
  processStartedAt: new Date().toISOString(),
  poll: {}
};

export function getStatus(): AppStatus {
  return state;
}

export function markPollStart(): void {
  state.poll.startedAt = new Date().toISOString();
}

export function markPollDoneOk(): void {
  const now = new Date().toISOString();
  state.poll.finishedAt = now;
  state.poll.lastOkAt = now;
  state.poll.lastError = undefined;
}

export function markPollDoneError(err: unknown): void {
  state.poll.finishedAt = new Date().toISOString();
  state.poll.lastError = String(err);
}

function webhook(): WebhookStatus {
  if (!state.webhook) {
    state.webhook = { enabled: false, received: 0, enqueued: 0, processed: 0, queueDepth: 0 };
  }
  return state.webhook;
}

export function setWebhookEnabled(enabled: boolean): void {
  webhook().enabled = enabled;
}

export function markWebhookReceived(eventType: string): void {
  const w = webhook();
  w.received += 1;
  w.lastEventType = eventType;
  w.lastEventAt = new Date().toISOString();
}

export function markWebhookEnqueued(queueDepth: number): void {
  const w = webhook();
  w.enqueued += 1;
  w.queueDepth = queueDepth;
}

export function setQueueDepth(queueDepth: number): void {
  webhook().queueDepth = queueDepth;
}

export function markWebhookProcessed(repoKey: string, queueDepth: number): void {
  const w = webhook();
  w.processed += 1;
  w.queueDepth = queueDepth;
  w.lastProcessedRepo = repoKey;
  w.lastProcessedAt = new Date().toISOString();
  w.lastError = undefined;
}

export function markWebhookError(err: unknown): void {
  webhook().lastError = String(err);
}
```

- [ ] **Step 3: Typecheck**

```bash
cd /home/radek/dev/autoworker && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
cd /home/radek/dev/autoworker && pnpm test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/radek/dev/autoworker && pnpm build && git add src/runner/serve.ts src/status.ts && git commit -m "feat: update serve.ts + strip dead worker status code"
```

---

## Task 8: Update job runner types + implementations + buildRunner

**Files:**
- Modify: `src/job-runner/types.ts`
- Modify: `src/job-runner/local-docker.ts`
- Modify: `src/job-runner/aca.ts`
- Modify: `src/runner/run-once.ts`
- Modify: `test/local-docker-runner.test.ts`

- [ ] **Step 1: Write failing tests for new env var injection**

Add to `test/local-docker-runner.test.ts` (append before the closing `}`):

```typescript
  it("runIssue injects ORCHESTRATOR_INTERNAL_URL and INTERNAL_WORKER_SECRET when provided", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub, {
      orchestratorInternalUrl: "http://host.docker.internal:8080",
      internalWorkerSecret: "abc123"
    });

    await runner.runIssue({
      issueUrl: "https://github.com/o/r/issues/1",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "c1"
    });

    const joined = calls[0].args.join(" ");
    expect(joined).toContain("ORCHESTRATOR_INTERNAL_URL=http://host.docker.internal:8080");
    expect(joined).toContain("INTERNAL_WORKER_SECRET=abc123");
  });

  it("runIssue omits ORCHESTRATOR_INTERNAL_URL and INTERNAL_WORKER_SECRET when not provided", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runIssue({
      issueUrl: "https://github.com/o/r/issues/1",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "c1"
    });

    const joined = calls[0].args.join(" ");
    expect(joined).not.toContain("ORCHESTRATOR_INTERNAL_URL");
    expect(joined).not.toContain("INTERNAL_WORKER_SECRET");
  });

  it("runPrReview injects ORCHESTRATOR_INTERNAL_URL and INTERNAL_WORKER_SECRET when provided", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub, {
      orchestratorInternalUrl: "http://host.docker.internal:9090",
      internalWorkerSecret: "xyz789"
    });

    await runner.runPrReview({
      issueUrl: "https://github.com/o/r/issues/1",
      prUrl: "https://github.com/o/r/pull/2",
      prBranch: "feat",
      baseBranch: "main",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "pr-c1"
    });

    const joined = calls[0].args.join(" ");
    expect(joined).toContain("ORCHESTRATOR_INTERNAL_URL=http://host.docker.internal:9090");
    expect(joined).toContain("INTERNAL_WORKER_SECRET=xyz789");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/radek/dev/autoworker && pnpm test test/local-docker-runner.test.ts
```

Expected: new tests fail.

- [ ] **Step 3: Update job runner types**

In `src/job-runner/types.ts`, add these two optional fields to **both** `ImplementationRunInput` and `PrReviewRunInput`:

```typescript
  orchestratorInternalUrl?: string;
  internalWorkerSecret?: string;
```

- [ ] **Step 4: Update LocalDockerJobRunner**

In `src/job-runner/local-docker.ts`, change the constructor and add env var injection.

Change the class definition:

```typescript
export type LocalDockerRunnerOpts = {
  orchestratorInternalUrl?: string;
  internalWorkerSecret?: string;
};

export class LocalDockerJobRunner implements JobRunner {
  constructor(
    private readonly spawnFn: SpawnFn = spawn,
    private readonly opts: LocalDockerRunnerOpts = {}
  ) {}
```

In `runIssue`, just before the closing `args.push(... input.workerImage)` line, add:

```typescript
    if (this.opts.orchestratorInternalUrl) args.push("-e", `ORCHESTRATOR_INTERNAL_URL=${this.opts.orchestratorInternalUrl}`);
    if (this.opts.internalWorkerSecret) args.push("-e", `INTERNAL_WORKER_SECRET=${this.opts.internalWorkerSecret}`);
```

Do the same in `runPrReview` just before `args.push(... input.workerImage)`.

- [ ] **Step 5: Update AcaJobRunner**

In `src/job-runner/aca.ts`, add to `AcaRunnerConfig`:

```typescript
  orchestratorInternalUrl?: string;
  internalWorkerSecret?: string;
```

In `runIssue`'s `env` object spread, add:

```typescript
        ...(this.cfg.orchestratorInternalUrl ? { ORCHESTRATOR_INTERNAL_URL: this.cfg.orchestratorInternalUrl } : {}),
        ...(this.cfg.internalWorkerSecret ? { INTERNAL_WORKER_SECRET: this.cfg.internalWorkerSecret } : {}),
```

Add the same two lines in `runPrReview`'s `env` spread.

- [ ] **Step 6: Update buildRunner in run-once.ts**

In `src/runner/run-once.ts`, add imports at the top:

```typescript
import { log } from "../log.js";
import { internalWorkerSecret } from "../api-gateway/internal-secret.js";
```

Replace the `buildRunner` function body:

```typescript
export function buildRunner(cfg: Config): JobRunner {
  const orchUrl =
    cfg.JOB_RUNNER === "local-docker"
      ? (cfg.ORCHESTRATOR_INTERNAL_URL ?? `http://host.docker.internal:${cfg.HEALTH_PORT}`)
      : cfg.ORCHESTRATOR_INTERNAL_URL;

  if (cfg.JOB_RUNNER === "aca") {
    if (!orchUrl) {
      log("warn", "runner.no_orchestrator_url", {
        runner: "aca",
        note: "ORCHESTRATOR_INTERNAL_URL not set; worker event streaming disabled"
      });
    }
    return new AcaJobRunner({
      subscriptionId: cfg.AZURE_SUBSCRIPTION_ID!,
      resourceGroup: cfg.AZURE_RESOURCE_GROUP!,
      location: cfg.AZURE_LOCATION!,
      environmentName: cfg.ACA_ENV_NAME!,
      jobNamePrefix: cfg.ACA_JOB_NAME,
      useManagedIdentity: cfg.AZURE_USE_MANAGED_IDENTITY,
      uamiId: cfg.AZURE_UAMI_ID,
      tenantId: cfg.AZURE_TENANT_ID,
      clientId: cfg.AZURE_CLIENT_ID,
      clientSecret: cfg.AZURE_CLIENT_SECRET,
      orchestratorInternalUrl: orchUrl,
      internalWorkerSecret
    });
  }

  return new LocalDockerJobRunner(undefined, {
    orchestratorInternalUrl: orchUrl,
    internalWorkerSecret
  });
}
```

- [ ] **Step 7: Run all tests**

```bash
cd /home/radek/dev/autoworker && pnpm test
```

Expected: all pass.

- [ ] **Step 8: Typecheck**

```bash
cd /home/radek/dev/autoworker && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
cd /home/radek/dev/autoworker && pnpm build && git add src/job-runner/types.ts src/job-runner/local-docker.ts src/job-runner/aca.ts src/runner/run-once.ts test/local-docker-runner.test.ts && git commit -m "feat(runner): inject ORCHESTRATOR_INTERNAL_URL + INTERNAL_WORKER_SECRET into containers"
```

---

## Task 9: Update orchestrate.ts to register workers

**Files:**
- Modify: `src/runner/orchestrate.ts`

The orchestrator registers a worker in the registry after successfully dispatching it. No test change needed — existing orchestrate tests pass `registry` as undefined implicitly since it becomes optional.

- [ ] **Step 1: Update orchestrate.ts**

Add the import at the top of `src/runner/orchestrate.ts`:

```typescript
import type { WorkerRegistry } from "../api-gateway/worker-registry.js";
```

Change the function signature to accept an optional registry as the last parameter:

```typescript
export async function runOrchestration(
  service: IssueService,
  runner: JobRunner,
  cfg: Config,
  repoKey: string,
  steps: RepoSteps,
  registry?: WorkerRegistry
): Promise<void> {
```

In the `steps.impl` block, after the successful `runner.runIssue()` call (the line `log("info", "orchestrate.impl.dispatched", ...)`), add:

```typescript
        registry?.register({
          correlationId,
          mode: "implementation",
          issueUrl: issue.url,
          issue: issueKey,
          runner: result.runner
        });
```

Note: `runner.runIssue()` currently returns `Promise<ImplementationRunResult>` but the return value is not currently captured. Change that line to capture the result:

```typescript
        const result = await runner.runIssue({ ... });
        registry?.register({
          correlationId,
          mode: "implementation",
          issueUrl: issue.url,
          issue: issueKey,
          runner: result.runner
        });
```

In the `steps.review` block, after `runner.runPrReview()`, similarly capture and register:

```typescript
        const result = await runner.runPrReview({ ... });
        registry?.register({
          correlationId,
          mode: "pr-review",
          issueUrl: issue.url,
          issue: `${repoKey}#${issue.number}`,
          runner: result.runner
        });
```

- [ ] **Step 2: Update serve.ts to pass the registry**

The call to `runOrchestration` in `serve.ts`'s `consumeWebhooks` already passes `workerRegistry` (from Task 7). Verify it compiles with the updated signature.

Also update `run-once.ts`'s `runOnce` function — it calls `runOrchestration` for each repo. Add `workerRegistry` as the last argument:

```typescript
import { workerRegistry } from "../api-gateway/worker-registry.js";
// ...
await runOrchestration(service, runner, cfg, repoKey, repo.steps, workerRegistry);
```

- [ ] **Step 3: Run all tests**

```bash
cd /home/radek/dev/autoworker && pnpm test
```

Expected: all pass.

- [ ] **Step 4: Typecheck**

```bash
cd /home/radek/dev/autoworker && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/radek/dev/autoworker && pnpm build && git add src/runner/orchestrate.ts src/runner/run-once.ts && git commit -m "feat(orchestrate): register workers in WorkerRegistry after dispatch"
```

---

## Task 10: Worker-side event push helper (docker/lib/events.mjs)

**Files:**
- Create: `docker/lib/events.mjs`

No TypeScript tests — this is an `.mjs` file tested via integration. Unit test would require mocking fetch; covered by the end-to-end flow.

- [ ] **Step 1: Create docker/lib/events.mjs**

```javascript
// Event push helper — sends lifecycle and log events to the orchestrator API.
// All functions are fire-and-forget; the worker never fails because of push errors.
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL || "";
const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "";
const CORRELATION_ID = process.env.CORRELATION_ID || "";

function nowIso() {
  return new Date().toISOString();
}

async function push(payload) {
  if (!ORCHESTRATOR_URL || !CORRELATION_ID) return;
  try {
    await fetch(`${ORCHESTRATOR_URL}/internal/workers/${encodeURIComponent(CORRELATION_ID)}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${INTERNAL_SECRET}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    // best-effort: never propagate push errors to the worker
  }
}

export function emitEvent(event, data = {}) {
  push({ type: "lifecycle", event, data, ts: nowIso() }).catch(() => {});
}

export async function emitEventAndWait(event, data = {}) {
  await push({ type: "lifecycle", event, data, ts: nowIso() });
}

export function emitLog(level, event, fields = {}) {
  push({ type: "log", level, event, fields, ts: nowIso() }).catch(() => {});
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/radek/dev/autoworker && git add docker/lib/events.mjs && git commit -m "feat(worker): add event push helper docker/lib/events.mjs"
```

---

## Task 11: Update docker/lib scripts to emit events

**Files:**
- Modify: `docker/lib/common.mjs`
- Modify: `docker/lib/implement.mjs`
- Modify: `docker/lib/review.mjs`

- [ ] **Step 1: Update common.mjs log() to call emitLog**

At the top of `docker/lib/common.mjs`, add the import after the existing imports:

```javascript
import { emitLog } from "./events.mjs";
```

Update the `log` function to also push to the orchestrator:

```javascript
export function log(level, msg, extra) {
  const record = { ts: nowIso(), level, msg, ...(extra ?? {}) };
  process.stderr.write(`${JSON.stringify(record)}\n`);
  emitLog(level, msg, extra ?? {});
}
```

- [ ] **Step 2: Update implement.mjs with lifecycle events**

At the top of `docker/lib/implement.mjs`, add the import:

```javascript
import { emitEvent, emitEventAndWait } from "./events.mjs";
```

Inside `runSingleImplementer`, after `log("info", "opencode.start", ...)`, add:

```javascript
  emitEvent("opencode.start", { model: opencodeEnv.LLM_MODEL, logSuffix });
```

After `log(... "opencode.done", ...)`, add:

```javascript
  emitEvent("opencode.done", { exitCode: ocExitCode });
```

Inside `runImplementation`, after the `gh repo clone` success check, add:

```javascript
  emitEvent("clone.done", { repoDir: CLONE_DIR });
```

In the grader loop, before `evalOutcome = await runGrader(...)`, add:

```javascript
        emitEvent("grader.start", { attempt: iteration, maxIterations });
```

After `evalOutcome = await runGrader(...)` returns, add:

```javascript
        emitEvent("grader.iteration", { pass: evalOutcome?.pass ?? false, attempt: iteration });
```

After the `log("info", "pr.create.done", ...)` line, add:

```javascript
  emitEvent("pr.created", { url: prUrl, branch: branchName });
```

Wrap the **entire body** of `runImplementation` in try/finally for the terminal event. Find the opening line `export async function runImplementation(ghEnv, CLONE_DIR, ARTIFACTS_DIR, WORKDIR, cfg) {` and restructure as:

```javascript
export async function runImplementation(ghEnv, CLONE_DIR, ARTIFACTS_DIR, WORKDIR, cfg) {
  emitEvent("harness.start", { ownerRepo: cfg.ownerRepo || null, issueNum: cfg.issueNum || null, llmModel: cfg.LLM_MODEL });
  try {
    // ... all existing implementation code unchanged ...
  } catch (err) {
    await emitEventAndWait("worker.finished", { outcome: "failed", error: String(err?.message || err) });
    throw err;
  }
  await emitEventAndWait("worker.finished", { outcome: "success" });
}
```

- [ ] **Step 3: Update review.mjs with lifecycle events**

At the top of `docker/lib/review.mjs`, add the import:

```javascript
import { emitEvent, emitEventAndWait } from "./events.mjs";
```

At the start of `runPrReview`, before the `log("info", "harness.pr_review.start", ...)` line, add:

```javascript
  emitEvent("review.start", { prUrl, branch: prBranch });
```

After `log(ocExitCode === 0 ? "info" : "warn", "opencode.review.done", ...)`, add:

```javascript
  emitEvent("opencode.done", { exitCode: ocExitCode });
```

After the `runWithRetry("gh", ["pr", "comment", ...])` call, add:

```javascript
    emitEvent("review.posted", { prNum });
```

Wrap the entire body of `runPrReview` in try/finally:

```javascript
export async function runPrReview(ghEnv, CLONE_DIR, ARTIFACTS_DIR) {
  // ... env var setup (before try) ...
  try {
    // ... all existing implementation code ...
  } catch (err) {
    await emitEventAndWait("worker.finished", { outcome: "failed", error: String(err?.message || err) });
    throw err;
  }
  await emitEventAndWait("worker.finished", { outcome: "success" });
}
```

- [ ] **Step 4: Verify docker scripts are syntactically valid**

```bash
node --check docker/lib/events.mjs && node --check docker/lib/common.mjs && node --check docker/lib/implement.mjs && node --check docker/lib/review.mjs
```

Expected: no syntax errors.

- [ ] **Step 5: Run all orchestrator tests**

```bash
cd /home/radek/dev/autoworker && pnpm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /home/radek/dev/autoworker && git add docker/lib/common.mjs docker/lib/implement.mjs docker/lib/review.mjs && git commit -m "feat(worker): emit lifecycle and log events via events.mjs"
```

---

## Task 12: env.example, Azure docs, Bruno collection, .gitignore

**Files:**
- Create: `env.example`
- Modify: `docs/azure-setup.md`
- Create: `bruno/autoworker/opencollection.yml`
- Create: `bruno/autoworker/environments/dev.yml`
- Create: `bruno/autoworker/health.yml`
- Create: `bruno/autoworker/workers-list.yml`
- Create: `bruno/autoworker/worker-stream.yml`
- Modify: `.gitignore`

- [ ] **Step 1: Create env.example**

Create `env.example`:

```bash
# GitHub auth
GITHUB_TOKEN=ghp_your_token_here

# Repos to watch (JSON array)
REPOS=[{"provider":"github","slug":"owner/repo","steps":["impl","review","merge"]}]

# Job runner: local-docker or aca
JOB_RUNNER=local-docker

# Worker Docker image
WORKER_IMAGE=autoworker-worker:local

# LLM provider — pick one
OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# AZURE_API_KEY=...
# AZURE_RESOURCE_NAME=my-resource

# Model to use (openai/..., anthropic/..., azure/<deployment>)
LLM_MODEL=openai/gpt-4o-mini

# API Gateway
# Bearer token required on GET /api/workers and GET /api/workers/:id/stream
API_KEY=change-me-to-a-random-secret

# Internal orchestrator URL reachable by worker containers.
# For local Docker this is auto-computed as http://host.docker.internal:<HEALTH_PORT>.
# For ACA set this to the orchestrator container app's internal FQDN.
# ORCHESTRATOR_INTERNAL_URL=http://autoworker-orchestrator.internal.example.com

# HTTP server
HEALTH_HOST=0.0.0.0
HEALTH_PORT=8080

# Webhook (serve mode only)
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# Work hours gate (poll mode; webhooks always run 24/7)
WORK_HOURS_START=7
WORK_HOURS_END=21
WORK_HOURS_TZ=Europe/Prague

# Poll interval in seconds
POLL_INTERVAL_SECONDS=900

# Azure Container Apps (JOB_RUNNER=aca only)
# AZURE_SUBSCRIPTION_ID=...
# AZURE_RESOURCE_GROUP=autoworker-rg
# AZURE_LOCATION=germanywestcentral
# AZURE_TENANT_ID=...
# AZURE_CLIENT_ID=...
# AZURE_CLIENT_SECRET=...
# ACA_ENV_NAME=autoworker-env
```

- [ ] **Step 2: Update docs/azure-setup.md Key Vault secrets table**

Find the secrets table in `docs/azure-setup.md`:

```markdown
| Secret | Used when |
|--------|-----------|
| `github-token` | always |
| `github-webhook-secret` | always (serve mode) |
```

Add a new row for `api-key`:

```markdown
| Secret | Used when |
|--------|-----------|
| `github-token` | always |
| `github-webhook-secret` | always (serve mode) |
| `api-key` | always — Bearer token for GET /api/workers and SSE stream |
```

- [ ] **Step 3: Create Bruno collection**

Create `bruno/autoworker/opencollection.yml`:

```yaml
opencollection: 1.0.0

info:
  name: autoworker
bundled: false
extensions:
  bruno:
    ignore:
      - node_modules
      - .git
```

Create `bruno/autoworker/environments/dev.yml`:

```yaml
name: dev
variables:
  - name: BASE_URL
    value: http://localhost:8080
  - name: WORKER_ID
    value: replace-with-a-correlationId
  - secret: true
    name: API_TOKEN
```

Create `bruno/autoworker/health.yml`:

```yaml
info:
  name: health
  type: http
  seq: 1

http:
  method: GET
  url: "{{BASE_URL}}/healthz"

settings:
  encodeUrl: true
  timeout: 10000
  followRedirects: true
  maxRedirects: 5
```

Create `bruno/autoworker/workers-list.yml`:

```yaml
info:
  name: workers-list
  type: http
  seq: 2

http:
  method: GET
  url: "{{BASE_URL}}/api/workers"
  auth:
    type: bearer
    token: "{{API_TOKEN}}"

settings:
  encodeUrl: true
  timeout: 10000
  followRedirects: true
  maxRedirects: 5
```

Create `bruno/autoworker/worker-stream.yml`:

```yaml
info:
  name: worker-stream
  type: http
  seq: 3

http:
  method: GET
  url: "{{BASE_URL}}/api/workers/{{WORKER_ID}}/stream"
  auth:
    type: bearer
    token: "{{API_TOKEN}}"

settings:
  encodeUrl: true
  timeout: 0
  followRedirects: false
  maxRedirects: 0
```

- [ ] **Step 4: Update .gitignore to protect Bruno environment secrets**

Add to `.gitignore`:

```
bruno/*/environments/
```

This prevents accidental commit of environment files containing real API tokens. The skeleton files in `bruno/autoworker/` (collection, requests) are committed; environment files with actual secrets are not.

- [ ] **Step 5: Stage Bruno skeleton without environment files**

```bash
cd /home/radek/dev/autoworker && git add bruno/autoworker/opencollection.yml bruno/autoworker/health.yml bruno/autoworker/workers-list.yml bruno/autoworker/worker-stream.yml
```

Verify the environment file is ignored:

```bash
git status bruno/autoworker/environments/dev.yml
```

Expected: shown as untracked (not staged).

- [ ] **Step 6: Run full test suite and typecheck**

```bash
cd /home/radek/dev/autoworker && pnpm test && pnpm typecheck
```

Expected: all pass, no errors.

- [ ] **Step 7: Commit everything**

```bash
cd /home/radek/dev/autoworker && pnpm build && git add env.example docs/azure-setup.md .gitignore && git commit -m "feat: env.example, Bruno collection, Azure docs, update .gitignore"
```

---

## Done

Run the full suite one final time to confirm:

```bash
cd /home/radek/dev/autoworker && pnpm test && pnpm typecheck && pnpm build
```

All tests pass, no type errors, build succeeds.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
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
    try {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    } finally {
      await app.close();
      registry.destroy();
    }
  });
});

describe("GET /api/workers", () => {
  let registry: WorkerRegistry;
  let app: FastifyInstance;
  beforeEach(() => {
    registry = new WorkerRegistry();
    app = makeApp(registry);
  });
  afterEach(async () => {
    await app.close();
    registry.destroy();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/api/workers" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 with wrong bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/workers", headers: { authorization: "Bearer wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with correct bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/workers", headers: { authorization: `Bearer ${API_KEY}` } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ workers: [] });
  });

  it("includes registered workers in the list", async () => {
    registry.register({ correlationId: "c1", mode: "implementation", issueUrl: "u", issue: "o/r#1", runner: "local-docker" });
    const res = await app.inject({ method: "GET", url: "/api/workers", headers: { authorization: `Bearer ${API_KEY}` } });
    const body = JSON.parse(res.body);
    expect(body.workers).toHaveLength(1);
    expect(body.workers[0].correlationId).toBe("c1");
    expect(body.workers[0].active).toBe(true);
  });
});

describe("POST /internal/workers/:id/events", () => {
  let registry: WorkerRegistry;
  let app: FastifyInstance;
  beforeEach(() => {
    registry = new WorkerRegistry();
    app = makeApp(registry);
  });
  afterEach(async () => {
    await app.close();
    registry.destroy();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await app.inject({
      method: "POST", url: "/internal/workers/c1/events",
      headers: { "content-type": "application/json" },
      payload: { type: "log", ts: "t", level: "info", event: "x", fields: {} }
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for unknown worker", async () => {
    const res = await app.inject({
      method: "POST", url: "/internal/workers/no-such/events",
      headers: { authorization: `Bearer ${INTERNAL_SECRET}`, "content-type": "application/json" },
      payload: { type: "log", ts: "t", level: "info", event: "x", fields: {} }
    });
    expect(res.statusCode).toBe(404);
  });

  it("appends event and returns seq for known worker", async () => {
    registry.register({ correlationId: "c1", mode: "implementation", issueUrl: "u", issue: "o/r#1", runner: "local-docker" });
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
  let app: FastifyInstance;
  beforeEach(() => {
    registry = new WorkerRegistry();
    app = makeApp(registry);
  });
  afterEach(async () => {
    await app.close();
    registry.destroy();
  });

  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/workers/c1/stream" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for unknown worker", async () => {
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

    const res = await app.inject({
      method: "GET", url: "/api/workers/c1/stream",
      headers: { authorization: `Bearer ${API_KEY}` }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.payload).toContain('"event":"harness.start"');
    expect(res.payload).toContain('"event":"worker.finished"');
    expect(res.payload).toContain('"type":"stream.closed"');
    expect(res.payload).toContain('"reason":"worker_finished"');
  });
});

describe("Dashboard workers UI (/dashboard/workers)", () => {
  let registry: WorkerRegistry;
  let app: FastifyInstance;
  beforeEach(() => {
    registry = new WorkerRegistry();
    app = makeApp(registry);
  });
  afterEach(async () => {
    await app.close();
    registry.destroy();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/workers" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Basic");
  });

  it("serves HTML with correct Basic auth", async () => {
    const basic = `Basic ${Buffer.from(`admin:${API_KEY}`).toString("base64")}`;
    const res = await app.inject({ method: "GET", url: "/dashboard/workers", headers: { authorization: basic } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.payload).toContain("Workers");
    expect(res.payload).toContain("/dashboard/workers.js");
  });

  it("allows /dashboard/api/workers with correct Basic auth", async () => {
    registry.register({ correlationId: "c1", mode: "implementation", issueUrl: "u", issue: "o/r#1", runner: "local-docker" });
    const basic = `Basic ${Buffer.from(`admin:${API_KEY}`).toString("base64")}`;
    const res = await app.inject({ method: "GET", url: "/dashboard/api/workers", headers: { authorization: basic } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ workers: [{ correlationId: "c1" }] });
  });
});

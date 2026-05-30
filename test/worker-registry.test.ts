import { describe, expect, it, beforeEach, afterEach } from "vitest";
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

import { describe, expect, it } from "vitest";
import { FifoQueue, type WebhookJob } from "../src/webhook/queue.js";

function job(repoKey: string, reason = "issues.opened"): WebhookJob {
  const [owner, repo] = repoKey.split("/");
  return { repo: { owner, repo }, repoKey, reason, enqueuedAt: new Date().toISOString() };
}

describe("FifoQueue", () => {
  it("returns enqueued jobs in FIFO order", async () => {
    const q = new FifoQueue();
    q.enqueue(job("o/a"));
    q.enqueue(job("o/b"));
    expect((await q.take()).repoKey).toBe("o/a");
    expect((await q.take()).repoKey).toBe("o/b");
  });

  it("coalesces repeated events for the same repo while pending", () => {
    const q = new FifoQueue();
    expect(q.enqueue(job("o/a"))).toBe(true);
    expect(q.enqueue(job("o/a"))).toBe(false);
    expect(q.enqueue(job("o/a"))).toBe(false);
    expect(q.depth).toBe(1);
  });

  it("allows re-enqueue after the job has been taken", async () => {
    const q = new FifoQueue();
    q.enqueue(job("o/a"));
    await q.take();
    expect(q.enqueue(job("o/a"))).toBe(true);
    expect(q.depth).toBe(1);
  });

  it("take() resolves when a job is enqueued later", async () => {
    const q = new FifoQueue();
    const pending = q.take();
    q.enqueue(job("o/late"));
    expect((await pending).repoKey).toBe("o/late");
  });

  it("hands a job directly to a waiting consumer without coalescing", async () => {
    const q = new FifoQueue();
    const first = q.take();
    q.enqueue(job("o/a"));
    expect((await first).repoKey).toBe("o/a");
    // A subsequent event for the same repo should now queue normally.
    expect(q.enqueue(job("o/a"))).toBe(true);
    expect(q.depth).toBe(1);
  });

  it("tracks depth", () => {
    const q = new FifoQueue();
    expect(q.depth).toBe(0);
    q.enqueue(job("o/a"));
    q.enqueue(job("o/b"));
    expect(q.depth).toBe(2);
  });
});

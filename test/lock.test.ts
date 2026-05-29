import { describe, expect, it } from "vitest";
import { Mutex } from "../src/runner/lock.js";

describe("Mutex", () => {
  it("serializes overlapping runs", async () => {
    const lock = new Mutex();
    const events: string[] = [];
    const slow = lock.run(async () => {
      events.push("a:start");
      await new Promise((r) => setTimeout(r, 20));
      events.push("a:end");
    });
    const fast = lock.run(async () => {
      events.push("b:start");
      events.push("b:end");
    });
    await Promise.all([slow, fast]);
    // b must not start until a has finished.
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("returns the function result", async () => {
    const lock = new Mutex();
    await expect(lock.run(async () => 42)).resolves.toBe(42);
  });

  it("releases the lock even when the function throws", async () => {
    const lock = new Mutex();
    await expect(lock.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // The lock should still be usable.
    await expect(lock.run(async () => "ok")).resolves.toBe("ok");
  });
});

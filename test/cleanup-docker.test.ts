import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupDockerContainers } from "../src/runner/cleanup.js";

vi.mock("../src/log.js", () => ({
  log: vi.fn()
}));

function makeDockerLine(name: string, createdAt: Date): string {
  const dockerTs = createdAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000 UTC");
  return JSON.stringify({ Names: name, CreatedAt: dockerTs });
}

const ONE_HOUR_MS = 60 * 60 * 1000;

describe("cleanupDockerContainers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes containers older than cutoff and skips fresh ones", () => {
    const now = Date.now();
    const old = new Date(now - 3 * ONE_HOUR_MS);
    const fresh = new Date(now - 1 * ONE_HOUR_MS);
    const psOutput = [makeDockerLine("old-container", old), makeDockerLine("fresh-container", fresh)].join("\n");

    const removed: string[] = [];
    const execDocker = (args: string[]): string => {
      if (args[0] === "ps") return psOutput;
      if (args[0] === "rm") removed.push(args[1]);
      return "";
    };

    cleanupDockerContainers(now - 2 * ONE_HOUR_MS, false, execDocker);

    expect(removed).toEqual(["old-container"]);
    expect(removed).not.toContain("fresh-container");
  });

  it("does not remove containers in dry-run mode", () => {
    const now = Date.now();
    const old = new Date(now - 5 * ONE_HOUR_MS);
    const psOutput = makeDockerLine("stale", old);

    const removed: string[] = [];
    const execDocker = (args: string[]): string => {
      if (args[0] === "ps") return psOutput;
      if (args[0] === "rm") removed.push(args[1]);
      return "";
    };

    cleanupDockerContainers(now - ONE_HOUR_MS, true, execDocker);

    expect(removed).toHaveLength(0);
  });

  it("handles leading slash in Names (real Docker output format)", () => {
    const now = Date.now();
    const old = new Date(now - 3 * ONE_HOUR_MS);
    const psOutput = makeDockerLine("/my-container", old);

    const removed: string[] = [];
    const execDocker = (args: string[]): string => {
      if (args[0] === "ps") return psOutput;
      if (args[0] === "rm") removed.push(args[1]);
      return "";
    };

    cleanupDockerContainers(now - ONE_HOUR_MS, false, execDocker);

    expect(removed).toEqual(["my-container"]);
  });

  it("docker ps command includes --filter status=exited and label filter", () => {
    const psArgs: string[] = [];
    const execDocker = (args: string[]): string => {
      if (args[0] === "ps") psArgs.push(...args);
      return "";
    };

    cleanupDockerContainers(Date.now(), false, execDocker);

    const statusFilterPresent = psArgs.some((a, i) => psArgs[i - 1] === "--filter" && a === "status=exited");
    const labelFilterPresent = psArgs.some((a, i) => psArgs[i - 1] === "--filter" && a.startsWith("label=autoworker"));
    expect(statusFilterPresent).toBe(true);
    expect(labelFilterPresent).toBe(true);
  });

  it("skips malformed JSON lines without throwing", () => {
    const now = Date.now();
    const old = new Date(now - 3 * ONE_HOUR_MS);
    const goodLine = makeDockerLine("good-container", old);
    const psOutput = ["not-json-at-all", goodLine].join("\n");

    const removed: string[] = [];
    const execDocker = (args: string[]): string => {
      if (args[0] === "ps") return psOutput;
      if (args[0] === "rm") removed.push(args[1]);
      return "";
    };

    expect(() => cleanupDockerContainers(now - ONE_HOUR_MS, false, execDocker)).not.toThrow();
    expect(removed).toEqual(["good-container"]);
  });

  it("parses real Docker timestamp format with timezone name", () => {
    const now = Date.now();
    const psOutput = JSON.stringify({ Names: "tz-container", CreatedAt: "2020-01-01 00:00:00 +0000 UTC" });

    const removed: string[] = [];
    const execDocker = (args: string[]): string => {
      if (args[0] === "ps") return psOutput;
      if (args[0] === "rm") removed.push(args[1]);
      return "";
    };

    cleanupDockerContainers(now, false, execDocker);

    expect(removed).toEqual(["tz-container"]);
  });

  it("logs warn and does not throw when Docker is unavailable", async () => {
    const { log } = await import("../src/log.js");

    const execDocker = (_args: string[]): string => {
      throw new Error("docker: command not found");
    };

    expect(() => cleanupDockerContainers(Date.now() - ONE_HOUR_MS, false, execDocker)).not.toThrow();
    expect(log).toHaveBeenCalledWith("warn", "cleanup.docker.unavailable", expect.anything());
  });

  it("handles empty output with no containers removed", () => {
    const removed: string[] = [];
    const execDocker = (args: string[]): string => {
      if (args[0] === "ps") return "";
      if (args[0] === "rm") removed.push(args[1]);
      return "";
    };

    expect(() => cleanupDockerContainers(Date.now() - ONE_HOUR_MS, false, execDocker)).not.toThrow();
    expect(removed).toHaveLength(0);
  });

  it("continues cleanup of remaining containers when docker rm fails for one", async () => {
    const { log } = await import("../src/log.js");

    const now = Date.now();
    const old = new Date(now - 3 * ONE_HOUR_MS);
    const line1 = makeDockerLine("container-a", old);
    const line2 = makeDockerLine("container-b", old);
    const removed: string[] = [];

    const execDocker = (args: string[]): string => {
      if (args[0] === "ps") return `${line1}\n${line2}`;
      if (args[0] === "rm" && args[1] === "container-a") throw new Error("no such container");
      if (args[0] === "rm" && args[1] === "container-b") {
        removed.push("container-b");
        return "";
      }
      return "";
    };

    expect(() => cleanupDockerContainers(now - ONE_HOUR_MS, false, execDocker)).not.toThrow();
    expect(removed).toEqual(["container-b"]);
    expect(log).toHaveBeenCalledWith("warn", "cleanup.docker.rm_failed", expect.objectContaining({ name: "container-a" }));
  });

  it("passes container name as separate arg to docker rm", () => {
    const now = Date.now();
    const old = new Date(now - 3 * ONE_HOUR_MS);
    const line = makeDockerLine("my-container", old);
    const rmArgs: string[][] = [];

    const execDocker = (args: string[]): string => {
      if (args[0] === "ps") return line;
      if (args[0] === "rm") rmArgs.push(args);
      return "";
    };

    cleanupDockerContainers(now - ONE_HOUR_MS, false, execDocker);

    expect(rmArgs).toHaveLength(1);
    expect(rmArgs[0]).toEqual(["rm", "my-container"]);
  });
});

import { describe, expect, it } from "vitest";
import { cleanupDockerContainers } from "../src/runner/cleanup.js";

function makeDockerLine(name: string, createdAt: Date): string {
  const dockerTs = createdAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000 UTC");
  return JSON.stringify({ Names: name, CreatedAt: dockerTs });
}

const ONE_HOUR_MS = 60 * 60 * 1000;

describe("cleanupDockerContainers", () => {
  it("removes containers older than cutoff", () => {
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

  it("docker ps command includes --filter status=exited", () => {
    const psArgs: string[] = [];
    const execDocker = (args: string[]): string => {
      if (args[0] === "ps") psArgs.push(...args);
      return "";
    };

    cleanupDockerContainers(Date.now(), false, execDocker);

    const filterIdx = psArgs.indexOf("--filter");
    const statusFilterPresent = psArgs.some((a, i) => psArgs[i - 1] === "--filter" && a === "status=exited");
    expect(filterIdx).toBeGreaterThan(-1);
    expect(statusFilterPresent).toBe(true);
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
});

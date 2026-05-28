import { describe, expect, it, vi } from "vitest";
import { cleanupDockerContainers } from "../src/runner/cleanup.js";

// Suppress log output in tests
vi.mock("../src/log.js", () => ({
  log: vi.fn()
}));

function makeDockerLine(name: string, createdAt: Date): string {
  // docker ps --format "{{json .}}" produces one JSON object per line
  return JSON.stringify({ Names: name, CreatedAt: createdAt.toISOString() });
}

describe("cleanupDockerContainers", () => {
  it("removes old stopped containers when dryRun=false", async () => {
    const removedNames: string[] = [];
    const oldDate = new Date(Date.now() - 72 * 3600 * 1000); // 72h ago
    const line = makeDockerLine("my-container", oldDate);

    const execSyncFn = vi.fn((cmd: string) => {
      if (cmd.startsWith("docker ps")) return line;
      if (cmd.startsWith("docker rm")) {
        // name is JSON-encoded (double-quoted) in the command
        const raw = cmd.replace("docker rm ", "").trim();
        removedNames.push(JSON.parse(raw));
        return "";
      }
      return "";
    });

    await cleanupDockerContainers(48, false, execSyncFn);

    expect(removedNames).toEqual(["my-container"]);
  });

  it("does not remove young containers below cutoff", async () => {
    const removedNames: string[] = [];
    const youngDate = new Date(Date.now() - 1 * 3600 * 1000); // 1h ago
    const line = makeDockerLine("young-container", youngDate);

    const execSyncFn = vi.fn((cmd: string) => {
      if (cmd.startsWith("docker ps")) return line;
      if (cmd.startsWith("docker rm")) {
        removedNames.push(cmd.replace("docker rm ", "").trim());
        return "";
      }
      return "";
    });

    await cleanupDockerContainers(48, false, execSyncFn);

    expect(removedNames).toHaveLength(0);
  });

  it("does not remove containers when dryRun=true even if old", async () => {
    const removedNames: string[] = [];
    const oldDate = new Date(Date.now() - 72 * 3600 * 1000);
    const line = makeDockerLine("old-container", oldDate);

    const execSyncFn = vi.fn((cmd: string) => {
      if (cmd.startsWith("docker ps")) return line;
      if (cmd.startsWith("docker rm")) {
        removedNames.push(cmd.replace("docker rm ", "").trim());
        return "";
      }
      return "";
    });

    await cleanupDockerContainers(48, true, execSyncFn);

    expect(removedNames).toHaveLength(0);
  });

  it("logs warn and does not throw when Docker is unavailable", async () => {
    const { log } = await import("../src/log.js");

    const execSyncFn = vi.fn((_cmd: string) => {
      throw new Error("docker: command not found");
    });

    await expect(cleanupDockerContainers(48, false, execSyncFn)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("warn", "cleanup.docker.unavailable", expect.anything());
  });

  it("handles empty output with no error", async () => {
    const execSyncFn = vi.fn((cmd: string) => {
      if (cmd.startsWith("docker ps")) return "";
      return "";
    });

    await expect(cleanupDockerContainers(48, false, execSyncFn)).resolves.toBeUndefined();
    // docker rm should never be called
    const rmCalls = execSyncFn.mock.calls.filter(([c]) => c.startsWith("docker rm"));
    expect(rmCalls).toHaveLength(0);
  });

  it("continues cleanup of remaining containers when docker rm fails for one", async () => {
    const { log } = await import("../src/log.js");

    const oldDate = new Date(Date.now() - 72 * 3600 * 1000);
    const line1 = makeDockerLine("container-a", oldDate);
    const line2 = makeDockerLine("container-b", oldDate);
    const removedNames: string[] = [];

    const execSyncFn = vi.fn((cmd: string) => {
      if (cmd.startsWith("docker ps")) return `${line1}\n${line2}`;
      if (cmd === `docker rm ${JSON.stringify("container-a")}`) throw new Error("no such container");
      if (cmd === `docker rm ${JSON.stringify("container-b")}`) {
        removedNames.push("container-b");
        return "";
      }
      return "";
    });

    await expect(cleanupDockerContainers(48, false, execSyncFn)).resolves.toBeUndefined();
    // container-b should still be removed even though container-a failed
    expect(removedNames).toEqual(["container-b"]);
    expect(log).toHaveBeenCalledWith("warn", "cleanup.docker.rm_failed", expect.objectContaining({ name: "container-a" }));
  });

  it("includes container name in docker rm command", async () => {
    const oldDate = new Date(Date.now() - 72 * 3600 * 1000);
    const line = makeDockerLine("my-container", oldDate);
    const rmCmds: string[] = [];

    const execSyncFn = vi.fn((cmd: string) => {
      if (cmd.startsWith("docker ps")) return line;
      if (cmd.startsWith("docker rm")) rmCmds.push(cmd);
      return "";
    });

    await cleanupDockerContainers(48, false, execSyncFn);

    expect(rmCmds).toHaveLength(1);
    // Container name appears JSON-encoded in the command
    expect(rmCmds[0]).toBe(`docker rm ${JSON.stringify("my-container")}`);
  });
});

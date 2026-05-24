import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { LocalDockerJobRunner } from "../src/job-runner/local-docker.js";

describe("LocalDockerJobRunner", () => {
  it("spawns docker run with expected env", async () => {
    const calls: any[] = [];
    const spawnStub: any = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    };

    const runner = new LocalDockerJobRunner(spawnStub);
    await runner.runIssue({
      issueUrl: "https://github.com/o/r/issues/1",
      githubToken: "gh",
      openaiApiKey: "ok",
      workerImage: "img:tag",
      correlationId: "c1"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("docker");
    expect(calls[0].args.join(" ")).toContain("run --rm");
    expect(calls[0].args.join(" ")).toContain("ISSUE_URL=https://github.com/o/r/issues/1");
  });
});

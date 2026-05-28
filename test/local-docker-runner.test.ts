import { describe, expect, it } from "vitest";
import { LocalDockerJobRunner } from "../src/job-runner/local-docker.js";

describe("LocalDockerJobRunner", () => {
  function makeSpawnStub() {
    const calls: { cmd: string; args: string[]; opts: any }[] = [];
    const spawnStub: any = (cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return { unref: () => {} };
    };
    return { calls, spawnStub };
  }

  it("spawns docker run with expected env", async () => {
    const { calls, spawnStub } = makeSpawnStub();
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
    expect(calls[0].args.join(" ")).toContain("ISSUE_URL=https://github.com/o/r/issues/1");
  });

  it("does not include --rm in docker args", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runIssue({
      issueUrl: "https://github.com/o/r/issues/1",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "c1"
    });

    expect(calls[0].args).not.toContain("--rm");
  });

  it("includes --name with sanitized correlationId", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runIssue({
      issueUrl: "https://github.com/o/r/issues/1",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "My-Corr_ID 1"
    });

    const nameIdx = calls[0].args.indexOf("--name");
    expect(nameIdx).toBeGreaterThan(-1);
    const containerName = calls[0].args[nameIdx + 1];
    expect(containerName).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/);
  });

  it("spawns with detached: true", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runIssue({
      issueUrl: "https://github.com/o/r/issues/1",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "c1"
    });

    expect(calls[0].opts.detached).toBe(true);
  });

  it("passes OPENCODE_AUTH_JSON when subscription auth is provided", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runIssue({
      issueUrl: "https://github.com/o/r/issues/1",
      githubToken: "gh",
      opencodeAuthJson: '{"anthropic":{"type":"oauth"}}',
      llmModel: "anthropic/claude-opus-4-7",
      workerImage: "img:tag",
      correlationId: "c1"
    });

    const argv = calls[0].args as string[];
    expect(argv).toContain(`OPENCODE_AUTH_JSON={"anthropic":{"type":"oauth"}}`);
    expect(argv.join(" ")).not.toContain("OPENAI_API_KEY");
  });

  it("passes ANTHROPIC_API_KEY when provided", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runIssue({
      issueUrl: "https://github.com/o/r/issues/1",
      githubToken: "gh",
      anthropicApiKey: "ant-key",
      workerImage: "img:tag",
      correlationId: "c1"
    });

    expect(calls[0].args.join(" ")).toContain("ANTHROPIC_API_KEY=ant-key");
  });

  it("passes AZURE env vars when provided", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runIssue({
      issueUrl: "https://github.com/o/r/issues/1",
      githubToken: "gh",
      azureApiKey: "az-key",
      azureResourceName: "my-resource",
      workerImage: "img:tag",
      correlationId: "c1"
    });

    const joined = calls[0].args.join(" ");
    expect(joined).toContain("AZURE_API_KEY=az-key");
    expect(joined).toContain("AZURE_RESOURCE_NAME=my-resource");
  });

  it("runPrReview spawns docker with WORKER_MODE=pr-review and PR env vars", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runPrReview({
      issueUrl: "https://github.com/o/r/issues/1",
      prUrl: "https://github.com/o/r/pull/42",
      prBranch: "feature/my-branch",
      baseBranch: "main",
      githubToken: "gh",
      openaiApiKey: "ok",
      workerImage: "img:tag",
      correlationId: "pr-c1"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("docker");
    const joined = calls[0].args.join(" ");
    expect(joined).toContain("WORKER_MODE=pr-review");
    expect(joined).toContain("PR_URL=https://github.com/o/r/pull/42");
    expect(joined).toContain("PR_BRANCH=feature/my-branch");
    expect(joined).toContain("BASE_BRANCH=main");
    expect(joined).toContain("ISSUE_URL=https://github.com/o/r/issues/1");
  });

  it("runPrReview container name matches sanitized correlationId (which carries the pr-review- prefix)", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    // correlationId format produced by orchestrate.ts always starts with "pr-review-"
    await runner.runPrReview({
      issueUrl: "https://github.com/o/r/issues/1",
      prUrl: "https://github.com/o/r/pull/42",
      prBranch: "feat",
      baseBranch: "main",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "pr-review-o-r-42-1716900000000"
    });

    const nameIdx = calls[0].args.indexOf("--name");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(calls[0].args[nameIdx + 1]).toMatch(/^pr-review-/);
    // No duplicate prefix: sanitizeContainerName(correlationId) is used directly
    expect(calls[0].args[nameIdx + 1]).not.toMatch(/^pr-review-pr-review-/);
  });

  it("runPrReview spawns with detached: true and no --rm", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runPrReview({
      issueUrl: "https://github.com/o/r/issues/1",
      prUrl: "https://github.com/o/r/pull/42",
      prBranch: "feat",
      baseBranch: "main",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "corr-42"
    });

    expect(calls[0].opts.detached).toBe(true);
    expect(calls[0].args).not.toContain("--rm");
  });

  it("runIssue includes autoworker.managed=true label", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runIssue({
      issueUrl: "https://github.com/o/r/issues/1",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "c1"
    });

    const args = calls[0].args as string[];
    const labelIdx = args.findIndex((a, i) => a === "--label" && args[i + 1] === "autoworker.managed=true");
    expect(labelIdx).toBeGreaterThan(-1);
  });

  it("runIssue includes autoworker.correlationId label matching correlationId", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runIssue({
      issueUrl: "https://github.com/o/r/issues/1",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "my-corr-id"
    });

    const args = calls[0].args as string[];
    const labelIdx = args.findIndex((a, i) => a === "--label" && args[i + 1] === "autoworker.correlationId=my-corr-id");
    expect(labelIdx).toBeGreaterThan(-1);
  });

  it("runPrReview includes autoworker.managed=true label", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runPrReview({
      issueUrl: "https://github.com/o/r/issues/1",
      prUrl: "https://github.com/o/r/pull/42",
      prBranch: "feat",
      baseBranch: "main",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "pr-corr-id"
    });

    const args = calls[0].args as string[];
    const labelIdx = args.findIndex((a, i) => a === "--label" && args[i + 1] === "autoworker.managed=true");
    expect(labelIdx).toBeGreaterThan(-1);
  });

  it("runPrReview includes autoworker.correlationId label matching correlationId", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runPrReview({
      issueUrl: "https://github.com/o/r/issues/1",
      prUrl: "https://github.com/o/r/pull/42",
      prBranch: "feat",
      baseBranch: "main",
      githubToken: "gh",
      workerImage: "img:tag",
      correlationId: "pr-corr-id"
    });

    const args = calls[0].args as string[];
    const labelIdx = args.findIndex((a, i) => a === "--label" && args[i + 1] === "autoworker.correlationId=pr-corr-id");
    expect(labelIdx).toBeGreaterThan(-1);
  });

  it("runPrReview passes OPENCODE_AUTH_JSON when subscription auth is provided", async () => {
    const { calls, spawnStub } = makeSpawnStub();
    const runner = new LocalDockerJobRunner(spawnStub);

    await runner.runPrReview({
      issueUrl: "https://github.com/o/r/issues/1",
      prUrl: "https://github.com/o/r/pull/42",
      prBranch: "feat",
      baseBranch: "main",
      githubToken: "gh",
      opencodeAuthJson: '{"anthropic":{"type":"oauth"}}',
      llmModel: "anthropic/claude-opus-4-7",
      workerImage: "img:tag",
      correlationId: "corr-42"
    });

    expect(calls[0].args.join(" ")).toContain(`OPENCODE_AUTH_JSON={"anthropic":{"type":"oauth"}}`);
    expect(calls[0].args.join(" ")).not.toContain("OPENAI_API_KEY");
  });
});

import { spawn } from "node:child_process";
import { log } from "../log.js";
import type { IssueRunInput, IssueRunResult, JobRunner } from "./types.js";

export type SpawnFn = typeof spawn;

export class LocalDockerJobRunner implements JobRunner {
  constructor(private readonly spawnFn: SpawnFn = spawn) {}

  async runIssue(input: IssueRunInput): Promise<IssueRunResult> {
    const args = [
      "run",
      "--rm",
      "-e",
      `GH_TOKEN=${input.githubToken}`,
      "-e",
      `GITHUB_TOKEN=${input.githubToken}`
    ];
    if (input.openaiApiKey) args.push("-e", `OPENAI_API_KEY=${input.openaiApiKey}`);
    if (input.anthropicApiKey) args.push("-e", `ANTHROPIC_API_KEY=${input.anthropicApiKey}`);
    if (input.azureApiKey) args.push("-e", `AZURE_API_KEY=${input.azureApiKey}`);
    if (input.azureResourceName) args.push("-e", `AZURE_RESOURCE_NAME=${input.azureResourceName}`);
    if (input.opencodeAuthJson) args.push("-e", `OPENCODE_AUTH_JSON=${input.opencodeAuthJson}`);
    args.push(
      "-e",
      `LLM_MODEL=${input.llmModel ?? "openai/gpt-5-mini"}`,
      "-e",
      `ISSUE_URL=${input.issueUrl}`,
      input.workerImage
    );

    log("info", "local_docker.start", { correlationId: input.correlationId, image: input.workerImage });

    const child = this.spawnFn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    child.stdout?.on("data", (buf) => log("info", "local_docker.stdout", { correlationId: input.correlationId, line: String(buf).trimEnd() }));
    child.stderr?.on("data", (buf) => log("warn", "local_docker.stderr", { correlationId: input.correlationId, line: String(buf).trimEnd() }));

    const exitCode: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 0));
    });

    if (exitCode !== 0) {
      throw new Error(`Local Docker worker failed (exit ${exitCode})`);
    }

    log("info", "local_docker.done", { correlationId: input.correlationId });
    return { runner: "local-docker" };
  }
}

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { log } from "../log.js";
import type { ImplementationRunInput, ImplementationRunResult, JobRunner, PrReviewRunInput, PrReviewRunResult } from "./types.js";

export type SpawnFn = typeof spawn;

function sanitizeContainerName(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function openLogStdio(correlationId: string): number | "ignore" {
  const logDir = process.env.LOG_DIR;
  if (!logDir) return "ignore";
  return fs.openSync(`${logDir}/${correlationId}.log`, "a");
}

export class LocalDockerJobRunner implements JobRunner {
  constructor(private readonly spawnFn: SpawnFn = spawn) {}

  runIssue(input: ImplementationRunInput): Promise<ImplementationRunResult> {
    const containerName = sanitizeContainerName(input.correlationId);
    const args = [
      "run",
      "--name",
      containerName,
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
      "--label",
      "autoworker.managed=true",
      "--label",
      `autoworker.correlationId=${input.correlationId}`,
      input.workerImage
    );

    log("info", "local_docker.start", { correlationId: input.correlationId, image: input.workerImage });

    const logFd = openLogStdio(input.correlationId);
    const child = this.spawnFn("docker", args, {
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      detached: true
    });
    child.unref();
    if (typeof logFd === "number") fs.closeSync(logFd);

    return Promise.resolve({ runner: "local-docker" });
  }

  runPrReview(input: PrReviewRunInput): Promise<PrReviewRunResult> {
    const containerName = `pr-review-${sanitizeContainerName(input.correlationId)}`;
    const args = [
      "run",
      "--name",
      containerName,
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
      `WORKER_MODE=pr-review`,
      "-e",
      `PR_URL=${input.prUrl}`,
      "-e",
      `PR_BRANCH=${input.prBranch}`,
      "-e",
      `BASE_BRANCH=${input.baseBranch}`,
      "-e",
      `ISSUE_URL=${input.issueUrl}`,
      "--label",
      "autoworker.managed=true",
      "--label",
      `autoworker.correlationId=${input.correlationId}`,
      input.workerImage
    );

    log("info", "local_docker.start", { correlationId: input.correlationId, image: input.workerImage });

    const logFd = openLogStdio(input.correlationId);
    const child = this.spawnFn("docker", args, {
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      detached: true
    });
    child.unref();
    if (typeof logFd === "number") fs.closeSync(logFd);

    return Promise.resolve({ runner: "local-docker" });
  }
}

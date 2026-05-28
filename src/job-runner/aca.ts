import { createAcaClient, createManualJob, startJob } from "../azure/client.js";
import { log } from "../log.js";
import type { ImplementationRunInput, ImplementationRunResult, JobRunner, PrReviewRunInput, PrReviewRunResult } from "./types.js";

export type AcaRunnerConfig = {
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  environmentName: string;
  jobNamePrefix: string;
  useManagedIdentity: boolean;
  uamiId?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
};

function envId(subscriptionId: string, resourceGroup: string, envName: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/managedEnvironments/${envName}`;
}

function makeJobName(prefix: string, correlationId: string): string {
  const jobPrefix = `${prefix}-`;
  const maxSuffixLen = 32 - jobPrefix.length;
  const safeSuffix = correlationId
    .replaceAll(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .slice(0, maxSuffixLen)
    .replace(/-+$/, "");
  return `${jobPrefix}${safeSuffix}`;
}

export class AcaJobRunner implements JobRunner {
  constructor(private readonly cfg: AcaRunnerConfig) {}

  async runIssue(input: ImplementationRunInput): Promise<ImplementationRunResult> {
    const jobName = makeJobName(this.cfg.jobNamePrefix, input.correlationId);

    log("info", "aca.create_and_start", { jobName, correlationId: input.correlationId });

    const aca = createAcaClient({
      subscriptionId: this.cfg.subscriptionId,
      useManagedIdentity: this.cfg.useManagedIdentity,
      tenantId: this.cfg.tenantId,
      clientId: this.cfg.clientId,
      clientSecret: this.cfg.clientSecret
    });

    await createManualJob(aca, {
      resourceGroup: this.cfg.resourceGroup,
      location: this.cfg.location,
      environmentId: envId(this.cfg.subscriptionId, this.cfg.resourceGroup, this.cfg.environmentName),
      jobName,
      image: input.workerImage,
      uamiId: this.cfg.uamiId,
      env: {
        GH_TOKEN: input.githubToken,
        GITHUB_TOKEN: input.githubToken,
        ...(input.openaiApiKey ? { OPENAI_API_KEY: input.openaiApiKey } : {}),
        ...(input.anthropicApiKey ? { ANTHROPIC_API_KEY: input.anthropicApiKey } : {}),
        ...(input.azureApiKey ? { AZURE_API_KEY: input.azureApiKey } : {}),
        ...(input.azureResourceName ? { AZURE_RESOURCE_NAME: input.azureResourceName } : {}),
        ...(input.opencodeAuthJson ? { OPENCODE_AUTH_JSON: input.opencodeAuthJson } : {}),
        LLM_MODEL: input.llmModel ?? "openai/gpt-5-mini",
        ISSUE_URL: input.issueUrl
      }
    });

    await startJob(aca, this.cfg.resourceGroup, jobName);
    return { runner: "aca", jobName };
  }

  async runPrReview(input: PrReviewRunInput): Promise<PrReviewRunResult> {
    const jobName = makeJobName(this.cfg.jobNamePrefix, input.correlationId);

    log("info", "aca.create_and_start", { jobName, correlationId: input.correlationId });

    const aca = createAcaClient({
      subscriptionId: this.cfg.subscriptionId,
      useManagedIdentity: this.cfg.useManagedIdentity,
      tenantId: this.cfg.tenantId,
      clientId: this.cfg.clientId,
      clientSecret: this.cfg.clientSecret
    });

    await createManualJob(aca, {
      resourceGroup: this.cfg.resourceGroup,
      location: this.cfg.location,
      environmentId: envId(this.cfg.subscriptionId, this.cfg.resourceGroup, this.cfg.environmentName),
      jobName,
      image: input.workerImage,
      uamiId: this.cfg.uamiId,
      env: {
        GH_TOKEN: input.githubToken,
        GITHUB_TOKEN: input.githubToken,
        ...(input.openaiApiKey ? { OPENAI_API_KEY: input.openaiApiKey } : {}),
        ...(input.anthropicApiKey ? { ANTHROPIC_API_KEY: input.anthropicApiKey } : {}),
        ...(input.azureApiKey ? { AZURE_API_KEY: input.azureApiKey } : {}),
        ...(input.azureResourceName ? { AZURE_RESOURCE_NAME: input.azureResourceName } : {}),
        LLM_MODEL: input.llmModel ?? "openai/gpt-5-mini",
        WORKER_MODE: "pr-review",
        PR_URL: input.prUrl,
        PR_BRANCH: input.prBranch,
        BASE_BRANCH: input.baseBranch,
        ISSUE_URL: input.issueUrl
      }
    });

    await startJob(aca, this.cfg.resourceGroup, jobName);
    return { runner: "aca", jobName };
  }
}

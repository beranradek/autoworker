import { createAcaClient, createManualJob, startJob } from "../azure/client.js";
import { log } from "../log.js";
import type { ImplementationRunInput, ImplementationRunResult, JobRunner, PrReviewRunInput, PrReviewRunResult } from "./types.js";
import type { ContainerAppsAPIClient } from "@azure/arm-appcontainers";

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

export function makeJobName(prefix: string, correlationId: string): string {
  const jobPrefix = `${prefix}-`;
  const maxSuffixLen = 32 - jobPrefix.length;
  if (maxSuffixLen <= 0) {
    // jobNamePrefix is too long to accommodate any suffix; return the prefix
    // trimmed to 32 chars (minus the trailing hyphen) so Azure accepts it.
    return jobPrefix.slice(0, 32).replace(/-+$/, "");
  }
  // Slice from the END so the timestamp (rightmost component) is always preserved,
  // ensuring uniqueness even when the correlationId has a long fixed-prefix segment
  // (e.g. "pr-review-<repo>-<issue>-<ts>") that would otherwise truncate away the
  // distinguishing issue number.
  const safeSuffix = correlationId
    .replaceAll(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .slice(-maxSuffixLen)
    .replace(/^-+|-+$/g, "");
  return `${jobPrefix}${safeSuffix}`;
}

export class AcaJobRunner implements JobRunner {
  private readonly aca: ContainerAppsAPIClient;

  constructor(private readonly cfg: AcaRunnerConfig) {
    this.aca = createAcaClient({
      subscriptionId: cfg.subscriptionId,
      useManagedIdentity: cfg.useManagedIdentity,
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret
    });
  }

  async runIssue(input: ImplementationRunInput): Promise<ImplementationRunResult> {
    const jobName = makeJobName(this.cfg.jobNamePrefix, input.correlationId);

    log("info", "aca.create_and_start", { jobName, correlationId: input.correlationId });

    await createManualJob(this.aca, {
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
        ISSUE_URL: input.issueUrl,
        ...(input.labelInProgress ? { ISSUE_LABEL_IN_PROGRESS: input.labelInProgress } : {}),
        ...(input.labelPrCreated ? { ISSUE_LABEL_PR_CREATED: input.labelPrCreated } : {}),
        CORRELATION_ID: input.correlationId
      }
    });

    await startJob(this.aca, this.cfg.resourceGroup, jobName);
    return { runner: "aca", jobName };
  }

  async runPrReview(input: PrReviewRunInput): Promise<PrReviewRunResult> {
    const jobName = makeJobName(this.cfg.jobNamePrefix, input.correlationId);

    log("info", "aca.create_and_start", { jobName, correlationId: input.correlationId });

    await createManualJob(this.aca, {
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
        WORKER_MODE: "pr-review",
        PR_URL: input.prUrl,
        PR_BRANCH: input.prBranch,
        BASE_BRANCH: input.baseBranch,
        ISSUE_URL: input.issueUrl,
        ...(input.labelInReview ? { ISSUE_LABEL_IN_REVIEW: input.labelInReview } : {}),
        ...(input.labelPrReviewed ? { ISSUE_LABEL_PR_REVIEWED: input.labelPrReviewed } : {}),
        ...(input.labelHumanNeeded ? { ISSUE_LABEL_HUMAN_NEEDED: input.labelHumanNeeded } : {})
      }
    });

    await startJob(this.aca, this.cfg.resourceGroup, jobName);
    return { runner: "aca", jobName };
  }
}

import { createAcaClient, createManualJob, startJob } from "../azure/client.js";
import { log } from "../log.js";
import type { IssueRunInput, IssueRunResult, JobRunner } from "./types.js";

export type AcaRunnerConfig = {
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  environmentName: string;
  jobNamePrefix: string;
  useManagedIdentity: boolean;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
};

function envId(subscriptionId: string, resourceGroup: string, envName: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/managedEnvironments/${envName}`;
}

export class AcaJobRunner implements JobRunner {
  constructor(private readonly cfg: AcaRunnerConfig) {}

  async runIssue(input: IssueRunInput): Promise<IssueRunResult> {
    const safeSuffix = input.correlationId.replaceAll(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 48);
    const jobName = `${this.cfg.jobNamePrefix}-issue-${safeSuffix}`.toLowerCase();

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
      env: {
        GH_TOKEN: input.githubToken,
        GITHUB_TOKEN: input.githubToken,
        OPENAI_API_KEY: input.openaiApiKey,
        OPENCODE_MODEL: input.opencodeModel ?? "gpt-5-mini",
        ISSUE_URL: input.issueUrl
      }
    });

    await startJob(aca, this.cfg.resourceGroup, jobName);
    return { runner: "aca", jobName };
  }
}

import { getConfig } from "../config.js";
import { log } from "../log.js";
import { createGitHubClient } from "../github/client.js";
import {
  addLabel,
  commentAccepted,
  hasAcceptanceMarker,
  hasAnyLabel,
  issueMentionsWorker,
  listOpenIssues
} from "../github/issues.js";
import type { RepoRef } from "../github/types.js";
import { createAcaClient, createManualJob, startJob } from "../azure/client.js";

function envId(subscriptionId: string, resourceGroup: string, envName: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/managedEnvironments/${envName}`;
}

function safeJobSuffix(): string {
  const now = new Date();
  const stamp =
    now
      .toISOString()
      .replaceAll(/[-:]/g, "")
      .replace(".000Z", "Z")
      .slice(0, 16) + "Z";
  return stamp.toLowerCase();
}

export async function runOnce(): Promise<void> {
  const cfg = getConfig();
  const dryRun = Boolean(cfg.DRY_RUN);
  const repo: RepoRef = { owner: cfg.GITHUB_OWNER, repo: cfg.GITHUB_REPO };

  const octokit = createGitHubClient(cfg.GITHUB_TOKEN);

  log("info", "poll.start", { repo: `${repo.owner}/${repo.repo}`, dryRun });

  const issues = await listOpenIssues(octokit, repo);
  log("info", "poll.found_issues", { count: issues.length });

  const blockedLabels = [cfg.LABEL_ACCEPTED, cfg.LABEL_IN_PROGRESS, cfg.LABEL_DONE];

  let accepted = 0;
  for (const issue of issues) {
    if (accepted >= cfg.MAX_ACCEPT_PER_RUN) {
      log("info", "poll.accept_limit_reached", { accepted, max: cfg.MAX_ACCEPT_PER_RUN });
      break;
    }

    const issueKey = `${repo.owner}/${repo.repo}#${issue.number}`;
    const issueUrl = issue.url;

    if (hasAnyLabel(issue, blockedLabels)) {
      log("debug", "issue.skip.label", { issue: issueKey, labels: issue.labels });
      continue;
    }

    if (await hasAcceptanceMarker(octokit, repo, issue.number)) {
      log("debug", "issue.skip.marker", { issue: issueKey });
      continue;
    }

    const mentions = await issueMentionsWorker(octokit, repo, issue, cfg.WORKER_MENTION);
    if (!mentions) {
      log("debug", "issue.skip.no_mention", { issue: issueKey });
      continue;
    }

    const jobName = `${cfg.ACA_JOB_NAME}-issue-${issue.number}-${safeJobSuffix()}`.toLowerCase();
    const correlationId = `${issue.number}-${Date.now()}`;

    log("info", "issue.accept", { issue: issueKey, issueUrl, jobName, correlationId });

    if (!dryRun) {
      await addLabel(octokit, repo, issue.number, cfg.LABEL_ACCEPTED);
      await commentAccepted(
        octokit,
        repo,
        issue.number,
        [
          `Accepted by autoworker.`,
          `Correlation: \`${correlationId}\``,
          `Starting ACA Job: \`${jobName}\``,
          `Worker image will create a PR and comment back here with the link.`
        ].join("\n")
      );
    }

    if (dryRun) {
      log("info", "aca.dry_run", { jobName, issueUrl });
      continue;
    }

    const aca = createAcaClient({
      subscriptionId: cfg.AZURE_SUBSCRIPTION_ID,
      useManagedIdentity: cfg.AZURE_USE_MANAGED_IDENTITY,
      tenantId: cfg.AZURE_TENANT_ID,
      clientId: cfg.AZURE_CLIENT_ID,
      clientSecret: cfg.AZURE_CLIENT_SECRET
    });

    await createManualJob(aca, {
      resourceGroup: cfg.AZURE_RESOURCE_GROUP,
      location: cfg.AZURE_LOCATION,
      environmentId: envId(cfg.AZURE_SUBSCRIPTION_ID, cfg.AZURE_RESOURCE_GROUP, cfg.ACA_ENV_NAME),
      jobName,
      image: cfg.WORKER_IMAGE,
      env: {
        GH_TOKEN: cfg.GITHUB_TOKEN,
        GITHUB_TOKEN: cfg.GITHUB_TOKEN,
        ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY,
        ISSUE_URL: issueUrl
      }
    });

    await startJob(aca, cfg.AZURE_RESOURCE_GROUP, jobName);
    log("info", "aca.started", { jobName, issue: issueKey });
    accepted += 1;
  }

  log("info", "poll.done");
}

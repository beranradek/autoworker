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
import { AcaJobRunner } from "../job-runner/aca.js";
import { LocalDockerJobRunner } from "../job-runner/local-docker.js";
import type { JobRunner } from "../job-runner/types.js";

export async function runOnce(): Promise<void> {
  const cfg = getConfig();
  const dryRun = Boolean(cfg.DRY_RUN);
  const octokit = createGitHubClient(cfg.GITHUB_TOKEN);

  const repos: RepoRef[] = cfg.GITHUB_REPOS.split(/[\s,]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((full) => {
      const [owner, repo] = full.split("/", 2);
      if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOS entry (expected owner/repo): ${full}`);
      return { owner, repo };
    });

  log("info", "poll.start", { repos: repos.map((r) => `${r.owner}/${r.repo}`), dryRun });

  const blockedLabels = [cfg.LABEL_ACCEPTED, cfg.LABEL_IN_PROGRESS, cfg.LABEL_DONE];

  const runner: JobRunner =
    cfg.JOB_RUNNER === "aca"
      ? new AcaJobRunner({
          subscriptionId: cfg.AZURE_SUBSCRIPTION_ID!,
          resourceGroup: cfg.AZURE_RESOURCE_GROUP!,
          location: cfg.AZURE_LOCATION!,
          environmentName: cfg.ACA_ENV_NAME!,
          jobNamePrefix: cfg.ACA_JOB_NAME,
          useManagedIdentity: cfg.AZURE_USE_MANAGED_IDENTITY,
          uamiId: cfg.AZURE_UAMI_ID,
          tenantId: cfg.AZURE_TENANT_ID,
          clientId: cfg.AZURE_CLIENT_ID,
          clientSecret: cfg.AZURE_CLIENT_SECRET
        })
      : new LocalDockerJobRunner();

  let accepted = 0;
  const inFlight = new Set<Promise<void>>();

  async function waitForFreeSlot() {
    while (inFlight.size >= cfg.MAX_CONCURRENT_WORKERS) {
      await Promise.race(Array.from(inFlight));
    }
  }

  for (const repo of repos) {
    if (accepted >= cfg.MAX_ACCEPT_PER_RUN) break;

    log("info", "poll.repo_start", { repo: `${repo.owner}/${repo.repo}` });
    let issues;
    try {
      issues = await listOpenIssues(octokit, repo);
    } catch (err) {
      log("warn", "poll.repo_error", { repo: `${repo.owner}/${repo.repo}`, error: String(err) });
      continue;
    }
    log("info", "poll.found_issues", { repo: `${repo.owner}/${repo.repo}`, count: issues.length });

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

      const correlationId = `${repo.owner}-${repo.repo}-${issue.number}-${Date.now()}`;
      log("info", "issue.accept", { issue: issueKey, issueUrl, runner: cfg.JOB_RUNNER, correlationId });

      await addLabel(octokit, repo, issue.number, cfg.LABEL_ACCEPTED);
      await commentAccepted(
        octokit,
        repo,
        issue.number,
        [
          `Accepted by autoworker.`,
          `Correlation: \`${correlationId}\``,
          cfg.JOB_RUNNER === "aca"
            ? `Runner: ACA (creating a per-issue job)`
            : `Runner: local-docker (running the worker container locally)`,
          dryRun ? `Dry run enabled: worker will NOT be started.` : `Worker image should create a PR and comment back here with the link.`
        ].join("\n")
      );

      if (dryRun) {
        log("info", "run.dry_run_claim_only", { correlationId, issueUrl });
        accepted += 1;
        continue;
      }

      await waitForFreeSlot();

      const task = runner
        .runIssue({
          issueUrl,
          githubToken: cfg.GITHUB_TOKEN,
          openaiApiKey: cfg.OPENAI_API_KEY,
          anthropicApiKey: cfg.ANTHROPIC_API_KEY,
          azureOpenaiApiKey: cfg.AZURE_OPENAI_API_KEY,
          azureOpenaiEndpoint: cfg.AZURE_OPENAI_ENDPOINT,
          workerImage: cfg.WORKER_IMAGE!,
          correlationId,
          llmModel: cfg.LLM_MODEL
        })
        .then((result) => {
          log("info", "run.done", { correlationId, runner: result.runner, jobName: result.jobName, issue: issueKey });
        })
        .catch((err) => {
          log("error", "run.error", { correlationId, issue: issueKey, error: String(err) });
        })
        .finally(() => {
          inFlight.delete(task);
        });

      inFlight.add(task);
      log("info", "run.dispatched", { correlationId, issue: issueKey, inFlight: inFlight.size });
      accepted += 1;
    }
  }

  if (inFlight.size > 0) {
    log("info", "poll.await_workers", { inFlight: inFlight.size });
    await Promise.all(Array.from(inFlight));
  }

  log("info", "poll.done");
}

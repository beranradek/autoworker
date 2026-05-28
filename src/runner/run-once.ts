import { getConfig } from "../config.js";
import { log } from "../log.js";
import { createGitHubClient } from "../github/client.js";
import { GitHubIssueService } from "../issues/github-service.js";
import type { RepoRef } from "../github/types.js";
import { AcaJobRunner } from "../job-runner/aca.js";
import { LocalDockerJobRunner } from "../job-runner/local-docker.js";
import type { JobRunner } from "../job-runner/types.js";
import { validateOpencodeAuthJson } from "../opencode-auth.js";
import { runOrchestration } from "./orchestrate.js";

export async function runOnce(): Promise<void> {
  const cfg = getConfig();
  const octokit = createGitHubClient(cfg.GITHUB_TOKEN);

  const repos: RepoRef[] = cfg.GITHUB_REPOS.split(/[\s,]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((full) => {
      const [owner, repo] = full.split("/", 2);
      if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOS entry (expected owner/repo): ${full}`);
      return { owner, repo };
    });

  log("info", "poll.start", { repos: repos.map((r) => `${r.owner}/${r.repo}`), dryRun: cfg.DRY_RUN });

  if (!cfg.DRY_RUN && cfg.OPENCODE_AUTH_JSON) {
    try {
      const v = validateOpencodeAuthJson(cfg.OPENCODE_AUTH_JSON);
      log("info", "opencode_auth.validated", { providers: v.providers, oauthProviders: v.oauthProviders });
      if (v.missingRefresh.length > 0) {
        log("warn", "opencode_auth.missing_refresh", {
          providers: v.missingRefresh,
          note: "no refresh token — the worker cannot renew an expired access token; re-run scripts/opencode-auth.sh login"
        });
      }
      if (v.expiredOauthProviders.length > 0) {
        log("warn", "opencode_auth.access_expired", {
          providers: v.expiredOauthProviders,
          note: "access token expired; the worker will try to refresh via the refresh token. If that fails, re-run scripts/opencode-auth.sh login (or refresh + push-azure/export-local)"
        });
      }
    } catch (err) {
      log("error", "opencode_auth.invalid", { error: String(err) });
      throw err;
    }
  }

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

  for (const repo of repos) {
    const repoKey = `${repo.owner}/${repo.repo}`;
    log("info", "poll.repo_start", { repo: repoKey });
    try {
      const service = new GitHubIssueService(octokit, repo, cfg);
      await runOrchestration(service, runner, cfg, repoKey);
    } catch (err) {
      log("error", "poll.repo_error", { repo: repoKey, error: String(err) });
    }
  }

  log("info", "poll.done");
}

import { getConfig } from "../config.js";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { createGitHubClient } from "../github/client.js";
import { GitHubIssueService } from "../issues/github-service.js";
import { GitLabIssueService } from "../issues/gitlab-service.js";
import { AcaJobRunner } from "../job-runner/aca.js";
import { LocalDockerJobRunner } from "../job-runner/local-docker.js";
import type { JobRunner } from "../job-runner/types.js";
import { internalWorkerSecret } from "../api-gateway/internal-secret.js";
import { workerRegistry } from "../api-gateway/worker-registry.js";
import { validateOpencodeAuthJson } from "../opencode-auth.js";
import { parseRepos } from "../repos.js";
import { createGitLabClient } from "../gitlab/client.js";
import { runOrchestration } from "./orchestrate.js";

export { parseRepos };

/** Construct the configured job runner (local Docker or Azure Container Apps). */
export function buildRunner(cfg: Config): JobRunner {
  const orchUrl =
    cfg.JOB_RUNNER === "local-docker"
      ? (cfg.ORCHESTRATOR_INTERNAL_URL ?? `http://host.docker.internal:${cfg.HEALTH_PORT}`)
      : cfg.ORCHESTRATOR_INTERNAL_URL;

  if (cfg.JOB_RUNNER === "aca") {
    if (!orchUrl) {
      log("warn", "runner.no_orchestrator_url", {
        runner: "aca",
        note: "ORCHESTRATOR_INTERNAL_URL not set; worker event streaming disabled"
      });
    }
    return new AcaJobRunner({
      subscriptionId: cfg.AZURE_SUBSCRIPTION_ID!,
      resourceGroup: cfg.AZURE_RESOURCE_GROUP!,
      location: cfg.AZURE_LOCATION!,
      environmentName: cfg.ACA_ENV_NAME!,
      jobNamePrefix: cfg.ACA_JOB_NAME,
      useManagedIdentity: cfg.AZURE_USE_MANAGED_IDENTITY,
      uamiId: cfg.AZURE_UAMI_ID,
      tenantId: cfg.AZURE_TENANT_ID,
      clientId: cfg.AZURE_CLIENT_ID,
      clientSecret: cfg.AZURE_CLIENT_SECRET,
      orchestratorInternalUrl: orchUrl,
      internalWorkerSecret
    });
  }

  return new LocalDockerJobRunner(undefined, {
    orchestratorInternalUrl: orchUrl,
    internalWorkerSecret
  });
}

/**
 * Validate the OpenCode subscription auth blob (when configured) and log any
 * warnings. Safe to call once at startup or per poll cycle.
 */
export function validateAuthIfNeeded(cfg: Config): void {
  if (cfg.DRY_RUN || !cfg.OPENCODE_AUTH_JSON) return;
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

export async function runOnce(): Promise<void> {
  const cfg = getConfig();
  const repos = parseRepos(cfg);

  log("info", "poll.start", {
    repos: repos.map((r) => `${r.provider}:${r.owner}/${r.repo}`),
    dryRun: cfg.DRY_RUN
  });

  validateAuthIfNeeded(cfg);

  const runner = buildRunner(cfg);

  for (const repo of repos) {
    const repoKey = `${repo.owner}/${repo.repo}`;
    log("info", "poll.repo_start", { repo: repoKey, steps: repo.steps });
    try {
      if (repo.provider === "github") {
        const githubToken = repo.repoToken ?? cfg.GITHUB_TOKEN;
        if (!githubToken) {
          log("error", "poll.repo_missing_token", { repo: repoKey, provider: "github", note: "Set GITHUB_TOKEN or repo_token for this repo" });
          continue;
        }
        const octokit = createGitHubClient(githubToken);
        const service = new GitHubIssueService(octokit, { owner: repo.owner, repo: repo.repo }, cfg);
        await runOrchestration(service, runner, cfg, repoKey, githubToken, repo.steps, workerRegistry);
        continue;
      }

      if (repo.provider === "gitlab") {
        const gitlabToken = repo.repoToken ?? cfg.GITLAB_TOKEN;
        if (!gitlabToken) {
          log("error", "poll.repo_missing_token", { repo: repoKey, provider: "gitlab", note: "Set GITLAB_TOKEN or repo_token for this repo" });
          continue;
        }
        const client = createGitLabClient({ baseUrl: cfg.GITLAB_BASE_URL, token: gitlabToken });
        const projectPath = encodeURIComponent(`${repo.owner}/${repo.repo}`);
        const service = new GitLabIssueService(client, projectPath, cfg);
        await runOrchestration(service, runner, cfg, repoKey, gitlabToken, repo.steps, workerRegistry);
        continue;
      }

      log("warn", "poll.provider_not_supported", { repo: repoKey, provider: repo.provider });
    } catch (err) {
      log("error", "poll.repo_error", { repo: repoKey, error: String(err) });
    }
  }

  log("info", "poll.done");
}

import { getConfig } from "../config.js";
import { log } from "../log.js";
import { createGitHubClient } from "../github/client.js";
import { addLabel, commentAccepted, hasAcceptanceMarker, hasAnyLabel, issueMentionsWorker, listOpenIssues } from "../github/issues.js";
import { AcaJobRunner } from "../job-runner/aca.js";
import { LocalDockerJobRunner } from "../job-runner/local-docker.js";
export async function runOnce() {
    const cfg = getConfig();
    const dryRun = Boolean(cfg.DRY_RUN);
    const repo = { owner: cfg.GITHUB_OWNER, repo: cfg.GITHUB_REPO };
    const octokit = createGitHubClient(cfg.GITHUB_TOKEN);
    log("info", "poll.start", { repo: `${repo.owner}/${repo.repo}`, dryRun });
    const issues = await listOpenIssues(octokit, repo);
    log("info", "poll.found_issues", { count: issues.length });
    const blockedLabels = [cfg.LABEL_ACCEPTED, cfg.LABEL_IN_PROGRESS, cfg.LABEL_DONE];
    const runner = cfg.JOB_RUNNER === "aca"
        ? new AcaJobRunner({
            subscriptionId: cfg.AZURE_SUBSCRIPTION_ID,
            resourceGroup: cfg.AZURE_RESOURCE_GROUP,
            location: cfg.AZURE_LOCATION,
            environmentName: cfg.ACA_ENV_NAME,
            jobNamePrefix: cfg.ACA_JOB_NAME,
            useManagedIdentity: cfg.AZURE_USE_MANAGED_IDENTITY,
            tenantId: cfg.AZURE_TENANT_ID,
            clientId: cfg.AZURE_CLIENT_ID,
            clientSecret: cfg.AZURE_CLIENT_SECRET
        })
        : new LocalDockerJobRunner();
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
        const correlationId = `${issue.number}-${Date.now()}`;
        log("info", "issue.accept", { issue: issueKey, issueUrl, runner: cfg.JOB_RUNNER, correlationId });
        if (!dryRun) {
            await addLabel(octokit, repo, issue.number, cfg.LABEL_ACCEPTED);
            await commentAccepted(octokit, repo, issue.number, [
                `Accepted by autoworker.`,
                `Correlation: \`${correlationId}\``,
                cfg.JOB_RUNNER === "aca"
                    ? `Runner: ACA (creating a per-issue job)`
                    : `Runner: local-docker (running the worker container locally)`,
                `Worker image should create a PR and comment back here with the link.`
            ].join("\n"));
        }
        if (dryRun) {
            log("info", "run.dry_run", { correlationId, issueUrl });
            continue;
        }
        const result = await runner.runIssue({
            issueUrl,
            githubToken: cfg.GITHUB_TOKEN,
            anthropicApiKey: cfg.ANTHROPIC_API_KEY,
            workerImage: cfg.WORKER_IMAGE,
            correlationId
        });
        log("info", "run.started", { correlationId, runner: result.runner, jobName: result.jobName, issue: issueKey });
        accepted += 1;
    }
    log("info", "poll.done");
}
//# sourceMappingURL=run-once.js.map
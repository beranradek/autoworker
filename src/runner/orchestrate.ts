import type { Config } from "../config.js";
import type { IssueService } from "../issues/service.js";
import type { JobRunner } from "../job-runner/types.js";
import { log } from "../log.js";

export async function runOrchestration(
  service: IssueService,
  runner: JobRunner,
  cfg: Config,
  repoKey: string
): Promise<void> {
  if (cfg.STEP_PR_MERGE) {
    const issues = await service.listIssuesByState("pr_reviewed");
    for (const issue of issues) {
      if (issue.prReviewOutcome === "human_needed") continue;
      try {
        const pr = await service.findLinkedPr(issue);
        if (!pr) {
          log("warn", "orchestrate.pr_merge.no_pr", { repo: repoKey, issue: issue.number });
          continue;
        }
        await service.mergePr(pr);
        await service.transitionTo(issue, "closed", { closeReason: "completed" });
        log("info", "orchestrate.pr_merge.done", { repo: repoKey, issue: issue.number, pr: pr.number });
      } catch (err) {
        log("error", "orchestrate.pr_merge.error", { repo: repoKey, issue: issue.number, error: String(err) });
      }
    }
  }

  if (cfg.STEP_PR_REVIEW) {
    const issues = await service.listIssuesByState("pr_created");
    for (const issue of issues) {
      try {
        if (await service.isPrReviewDispatched(issue)) continue;
        const pr = await service.findLinkedPr(issue);
        if (!pr) {
          log("warn", "orchestrate.pr_review.no_pr", { repo: repoKey, issue: issue.number });
          continue;
        }
        if (cfg.DRY_RUN) {
          log("info", "orchestrate.pr_review.dry_run", { repo: repoKey, issue: issue.number });
          continue;
        }
        await service.markPrReviewDispatched(issue);
        const correlationId = `pr-review-${repoKey.replace("/", "-")}-${issue.number}-${Date.now()}`;
        try {
          await runner.runPrReview({
            issueUrl: issue.url,
            prUrl: pr.url,
            prBranch: pr.branch,
            baseBranch: pr.baseBranch,
            githubToken: cfg.GITHUB_TOKEN,
            openaiApiKey: cfg.OPENAI_API_KEY,
            anthropicApiKey: cfg.ANTHROPIC_API_KEY,
            azureApiKey: cfg.AZURE_API_KEY,
            azureResourceName: cfg.AZURE_RESOURCE_NAME,
            opencodeAuthJson: cfg.OPENCODE_AUTH_JSON,
            workerImage: cfg.PR_REVIEW_WORKER_IMAGE ?? cfg.WORKER_IMAGE!,
            correlationId,
            llmModel: cfg.LLM_MODEL
          });
        } catch (runErr) {
          // markPrReviewDispatched already succeeded, so the issue has the
          // pr-review-dispatched label but no worker running. It will not be
          // retried automatically. Remove the label manually to re-enable dispatch.
          log("error", "orchestrate.pr_review.run_failed", {
            repo: repoKey,
            issue: issue.number,
            correlationId,
            error: String(runErr),
            note: `pr-review-dispatched label was set but the worker failed to start; remove the "${cfg.LABEL_PR_REVIEW_DISPATCHED}" label from issue #${issue.number} to allow a re-dispatch`
          });
          throw runErr;
        }
        log("info", "orchestrate.pr_review.dispatched", { repo: repoKey, issue: issue.number, correlationId });
      } catch (err) {
        log("error", "orchestrate.pr_review.error", { repo: repoKey, issue: issue.number, error: String(err) });
      }
    }
  }

  if (cfg.STEP_IMPLEMENTATION) {
    const issues = await service.listIssuesByState("open");
    let accepted = 0;
    for (const issue of issues) {
      if (accepted >= cfg.MAX_ACCEPT_PER_RUN) break;
      try {
        const mentioned = await service.isMentionedByWorker(issue);
        if (!mentioned) {
          log("debug", "orchestrate.impl.skip.no_mention", { repo: repoKey, issue: issue.number });
          continue;
        }
        const issueKey = `${repoKey}#${issue.number}`;
        const correlationId = `${repoKey.replace("/", "-")}-${issue.number}-${Date.now()}`;
        log("info", "orchestrate.impl.accept", { repo: repoKey, issue: issueKey });
        if (cfg.DRY_RUN) {
          await service.transitionTo(issue, "in_progress");
          log("info", "orchestrate.impl.dry_run", { repo: repoKey, issue: issueKey, correlationId });
          accepted++;
          continue;
        }
        await runner.runIssue({
          issueUrl: issue.url,
          githubToken: cfg.GITHUB_TOKEN,
          openaiApiKey: cfg.OPENAI_API_KEY,
          anthropicApiKey: cfg.ANTHROPIC_API_KEY,
          azureApiKey: cfg.AZURE_API_KEY,
          azureResourceName: cfg.AZURE_RESOURCE_NAME,
          opencodeAuthJson: cfg.OPENCODE_AUTH_JSON,
          workerImage: cfg.WORKER_IMAGE!,
          correlationId,
          llmModel: cfg.LLM_MODEL
        });
        // Count the issue as accepted immediately after the runner launches so that
        // a transitionTo failure below does not allow a second worker to be dispatched
        // for the same issue within this poll cycle.
        accepted++;
        log("info", "orchestrate.impl.dispatched", { repo: repoKey, issue: issueKey, correlationId });
        // Claim the issue only after the runner has successfully launched the worker,
        // so a runner failure leaves the issue in "open" state and it can be retried.
        try {
          await service.transitionTo(issue, "in_progress");
        } catch (labelErr) {
          // Worker is already running. The issue will appear as "open" on the next poll
          // and a second worker will be dispatched unless the label is added manually.
          log("error", "orchestrate.impl.label_failed", {
            repo: repoKey,
            issue: issueKey,
            correlationId,
            error: String(labelErr),
            note: `worker container started but in-progress label could not be set; add the "${cfg.LABEL_IN_PROGRESS}" label to issue ${issueKey} manually to prevent a duplicate dispatch on the next poll`
          });
        }
      } catch (err) {
        log("error", "orchestrate.impl.error", { repo: repoKey, issue: issue.number, error: String(err) });
      }
    }
  }
}

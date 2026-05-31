import type { Config } from "../config.js";
import type { IssueService } from "../issues/service.js";
import type { JobRunner } from "../job-runner/types.js";
import type { RepoSteps } from "../repos.js";
import { log } from "../log.js";
import type { WorkerRegistry } from "../api-gateway/worker-registry.js";

export async function runOrchestration(
  service: IssueService,
  runner: JobRunner,
  cfg: Config,
  repoKey: string,
  githubToken: string,
  steps: RepoSteps,
  registry?: WorkerRegistry,
  opts?: { labelsEnsured?: boolean }
): Promise<void> {
  if (!opts?.labelsEnsured) {
    await service.ensureLabels();
  }

  if (steps.merge) {
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

  if (steps.review) {
    const issues = await service.listIssuesByState("pr_created");
    for (const issue of issues) {
      try {
        if (await service.isInReview(issue)) continue;
        const pr = await service.findLinkedPr(issue);
        if (!pr) {
          log("warn", "orchestrate.pr_review.no_pr", { repo: repoKey, issue: issue.number });
          continue;
        }
        if (cfg.DRY_RUN) {
          log("info", "orchestrate.pr_review.dry_run", { repo: repoKey, issue: issue.number });
          continue;
        }
        const correlationId = `pr-review-${repoKey.replace("/", "-")}-${issue.number}-${Date.now()}`;
        await service.markInReview(issue);
        try {
          const result = await runner.runPrReview({
            issueUrl: issue.url,
            prUrl: pr.url,
            prBranch: pr.branch,
            baseBranch: pr.baseBranch,
            githubToken,
            openaiApiKey: cfg.OPENAI_API_KEY,
            anthropicApiKey: cfg.ANTHROPIC_API_KEY,
            azureApiKey: cfg.AZURE_API_KEY,
            azureResourceName: cfg.AZURE_RESOURCE_NAME,
            opencodeAuthJson: cfg.OPENCODE_AUTH_JSON,
            workerImage: cfg.PR_REVIEW_WORKER_IMAGE ?? cfg.WORKER_IMAGE!,
            correlationId,
            llmModel: cfg.LLM_MODEL,
            labelInReview: cfg.LABEL_IN_REVIEW,
            labelPrReviewed: cfg.LABEL_PR_REVIEWED,
            labelHumanNeeded: cfg.LABEL_HUMAN_NEEDED
          });
          registry?.register({
            correlationId,
            mode: "pr-review",
            issueUrl: issue.url,
            issue: `${repoKey}#${issue.number}`,
            runner: result.runner
          });
        } catch (runErr) {
          // Roll back the in-review label so the next poll can retry dispatch.
          // This mirrors the "never strand work behind a label" principle used
          // in autofactory’s workflows.
          try {
            await service.unmarkInReview(issue);
          } catch (rollbackErr) {
            log("error", "orchestrate.pr_review.rollback_failed", {
              repo: repoKey,
              issue: issue.number,
              correlationId,
              error: String(rollbackErr)
            });
          }
          log("error", "orchestrate.pr_review.run_failed", {
            repo: repoKey,
            issue: issue.number,
            correlationId,
            error: String(runErr),
            note: `worker failed to start; in-review label was rolled back to allow a re-dispatch on the next poll`
          });
          throw runErr;
        }
        log("info", "orchestrate.pr_review.dispatched", { repo: repoKey, issue: issue.number, correlationId });
      } catch (err) {
        log("error", "orchestrate.pr_review.error", { repo: repoKey, issue: issue.number, error: String(err) });
      }
    }
  }

  if (steps.impl) {
    const pendingInfos = await service.listPendingIssues();
    if (pendingInfos.length === 0) return;

    const issues = await service.listIssuesByState("open");
    const issuesByNumber = new Map<number, (typeof issues)[number]>();
    for (const issue of issues) issuesByNumber.set(issue.number, issue);

    let accepted = 0;
    for (const info of pendingInfos) {
      if (accepted >= cfg.MAX_ACCEPT_PER_RUN) break;
      if (!info.ready) continue;
      const issue = issuesByNumber.get(info.number);
      if (!issue) continue;
      try {
        const issueKey = `${repoKey}#${issue.number}`;
        const correlationId = `${repoKey.replace("/", "-")}-${issue.number}-${Date.now()}`;
        log("info", "orchestrate.impl.accept", { repo: repoKey, issue: issueKey });
        if (cfg.DRY_RUN) {
          await service.transitionTo(issue, "in_progress");
          log("info", "orchestrate.impl.dry_run", { repo: repoKey, issue: issueKey, correlationId });
          accepted++;
          continue;
        }
        // Claim the issue first (label it) to prevent a duplicate dispatch by
        // another orchestrator instance. If dispatch fails, roll back the label
        // so the next poll can retry.
        await service.transitionTo(issue, "in_progress");
        const result = await runner.runIssue({
          issueUrl: issue.url,
          githubToken,
          openaiApiKey: cfg.OPENAI_API_KEY,
          anthropicApiKey: cfg.ANTHROPIC_API_KEY,
          azureApiKey: cfg.AZURE_API_KEY,
          azureResourceName: cfg.AZURE_RESOURCE_NAME,
          opencodeAuthJson: cfg.OPENCODE_AUTH_JSON,
          workerImage: cfg.WORKER_IMAGE!,
          correlationId,
          llmModel: cfg.LLM_MODEL,
          labelInProgress: cfg.LABEL_IN_PROGRESS,
          labelPrCreated: cfg.LABEL_PR_CREATED
        });
        registry?.register({
          correlationId,
          mode: "implementation",
          issueUrl: issue.url,
          issue: issueKey,
          runner: result.runner
        });
        log("info", "orchestrate.impl.dispatched", { repo: repoKey, issue: issueKey, correlationId });
        accepted++;
      } catch (err) {
        // Best-effort rollback of the in-progress label. This avoids stranding
        // an issue in a claimed state when the worker fails to launch.
        try {
          await service.unmarkInProgress(issue);
        } catch (rollbackErr) {
          log("error", "orchestrate.impl.rollback_failed", {
            repo: repoKey,
            issue: issue.number,
            error: String(rollbackErr)
          });
        }
        log("error", "orchestrate.impl.error", { repo: repoKey, issue: issue.number, error: String(err) });
      }
    }
  }
}

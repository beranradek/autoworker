import { getConfig } from "../config.js";
import { log } from "../log.js";
import { createGitHubClient } from "../github/client.js";
import { GitHubIssueService } from "../issues/github-service.js";
import { startHealthServer } from "../health/server.js";
import { isWithinWorkHours, secondsUntilNextWorkWindow } from "../schedule/work-hours.js";
import {
  markWebhookError,
  markWebhookProcessed,
  setQueueDepth,
  setWebhookEnabled
} from "../status.js";
import { FifoQueue } from "../webhook/queue.js";
import { Mutex } from "./lock.js";
import { buildRunner, parseRepos, validateAuthIfNeeded } from "./run-once.js";
import { pollLoop } from "./poll.js";
import { runOrchestration } from "./orchestrate.js";
import type { Config } from "../config.js";
import type { Octokit } from "@octokit/rest";
import type { JobRunner } from "../job-runner/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drain the webhook queue forever, running orchestration for each repo whose
 * events arrived. Respects work hours (matching the poll loop) so workers are
 * not dispatched outside the configured window — events stay queued until the
 * window reopens. Runs under the shared lock so it never overlaps the
 * safety-net poll.
 */
async function consumeWebhooks(
  queue: FifoQueue,
  octokit: Octokit,
  runner: JobRunner,
  cfg: Config,
  lock: Mutex
): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!isWithinWorkHours(new Date(), {
      timeZone: cfg.WORK_HOURS_TZ,
      startHour: cfg.WORK_HOURS_START,
      endHour: cfg.WORK_HOURS_END
    })) {
      const secondsUntil = secondsUntilNextWorkWindow(new Date(), {
        timeZone: cfg.WORK_HOURS_TZ,
        startHour: cfg.WORK_HOURS_START,
        endHour: cfg.WORK_HOURS_END
      });
      // Don't take from the queue while outside work hours — events accumulate
      // (coalesced per repo) and are drained when the window reopens.
      await sleep(Math.min(Math.max(secondsUntil, 60), 15 * 60) * 1000);
      continue;
    }

    const job = await queue.take();
    setQueueDepth(queue.depth);

    // A work-hours boundary may have been crossed while parked on take(); if so,
    // put the job back and loop to the sleep branch above.
    if (!isWithinWorkHours(new Date(), {
      timeZone: cfg.WORK_HOURS_TZ,
      startHour: cfg.WORK_HOURS_START,
      endHour: cfg.WORK_HOURS_END
    })) {
      queue.enqueue(job);
      continue;
    }

    log("info", "webhook.process_start", { repo: job.repoKey, reason: job.reason });
    try {
      const service = new GitHubIssueService(octokit, job.repo, cfg);
      await lock.run(() => runOrchestration(service, runner, cfg, job.repoKey));
      markWebhookProcessed(job.repoKey, queue.depth);
      log("info", "webhook.process_done", { repo: job.repoKey });
    } catch (err) {
      markWebhookError(err);
      log("error", "webhook.process_error", { repo: job.repoKey, error: String(err) });
    }
  }
}

/**
 * Long-running, event-driven mode:
 *   - exposes POST /webhook (HMAC-verified) feeding an in-memory FIFO queue,
 *   - drains the queue to run orchestration reactively,
 *   - keeps a safety-net poll loop running in case a webhook delivery is missed.
 *
 * Intended to run as a single always-on replica (the queue is process-local).
 */
export async function serve(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.GITHUB_WEBHOOK_SECRET) {
    throw new Error(
      "serve mode requires GITHUB_WEBHOOK_SECRET to secure the POST /webhook endpoint (set it to the secret configured on the GitHub webhook)"
    );
  }

  const octokit = createGitHubClient(cfg.GITHUB_TOKEN);
  const repos = parseRepos(cfg);
  validateAuthIfNeeded(cfg);
  const runner = buildRunner(cfg);
  const queue = new FifoQueue();
  const lock = new Mutex();

  setWebhookEnabled(true);
  startHealthServer({ webhook: { secret: cfg.GITHUB_WEBHOOK_SECRET, queue, repos } });
  log("info", "serve.start", {
    repos: repos.map((r) => `${r.owner}/${r.repo}`),
    webhookPath: "/webhook",
    safetyPollIntervalSeconds: cfg.POLL_INTERVAL_SECONDS
  });

  // Run the webhook consumer and the safety-net poll concurrently. Both share
  // the lock so orchestration runs never overlap. Neither resolves; if either
  // throws fatally, surface it so the process exits and the platform restarts it.
  await Promise.race([consumeWebhooks(queue, octokit, runner, cfg, lock), pollLoop({ lock })]);
}

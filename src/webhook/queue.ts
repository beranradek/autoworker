import type { RepoRef } from "../github/types.js";
import type { RepoSteps } from "../repos.js";

export type WebhookJob = {
  repo: RepoRef;
  repoKey: string;
  steps: RepoSteps;
  /** Optional per-repo access token override (PAT). */
  repoToken?: string;
  /** GitHub webhook event type (e.g. "issues", "pull_request"). */
  eventType?: string;
  /** Issue/PR number, when present in webhook payload. */
  number?: number;
  /** Human-readable description of the event that triggered this job (for logs). */
  reason: string;
  enqueuedAt: string;
};

/**
 * In-memory FIFO work queue for webhook-triggered orchestration.
 *
 * Jobs are deduplicated by `repoKey`: while a repo already has a pending job,
 * further events for the same repo are coalesced into the existing one. This is
 * safe because orchestration is a full, idempotent scan of the repo's issues —
 * a single run after a burst of events does the same work as one run per event.
 *
 * The queue is intentionally volatile (process-local). A lost queue on restart
 * is recovered by the safety-net poll, and the label-based state machine makes
 * reprocessing idempotent. Because it is not shared across processes, the
 * orchestrator must run as a single replica.
 */
export class FifoQueue {
  private order: string[] = [];
  private jobs = new Map<string, WebhookJob>();
  private waiters: Array<(job: WebhookJob) => void> = [];

  /**
   * Enqueue a job. Returns true if it was queued (or handed straight to a
   * waiting consumer), false if it was coalesced into an already-pending job
   * for the same repo.
   */
  enqueue(job: WebhookJob): boolean {
    // A parked consumer only exists when the queue is empty, so there is no
    // pending job to coalesce against — hand the work off directly.
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(job);
      return true;
    }
    if (this.jobs.has(job.repoKey)) {
      return false;
    }
    this.jobs.set(job.repoKey, job);
    this.order.push(job.repoKey);
    return true;
  }

  /** Take the next job, waiting until one is available. */
  take(): Promise<WebhookJob> {
    const key = this.order.shift();
    if (key !== undefined) {
      const job = this.jobs.get(key)!;
      this.jobs.delete(key);
      return Promise.resolve(job);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Number of jobs currently waiting to be processed. */
  get depth(): number {
    return this.order.length;
  }
}

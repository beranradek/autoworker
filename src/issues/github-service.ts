import type { Octokit } from "@octokit/rest";
import type { CloseReason, Issue, IssueState, PrInfo, PrReviewOutcome } from "./model.js";
import type { IssueService } from "./service.js";
import type { RepoRef } from "../github/types.js";
import type { Config } from "../config.js";
import { containsMention } from "../github/mentions.js";
import { normalizeLabels } from "../github/issues.js";
import { log } from "../log.js";

export class GitHubIssueService implements IssueService {
  constructor(private octokit: Octokit, private repo: RepoRef, private cfg: Config) {}

  async listIssuesByState(state: IssueState): Promise<Issue[]> {
    const apiState = state === "closed" ? "closed" : "open";
    const res = await this.octokit.issues.listForRepo({
      owner: this.repo.owner,
      repo: this.repo.repo,
      state: apiState,
      per_page: 100,
      sort: "created",
      direction: "asc"
    });

    const raw = res.data.filter((i) => !i.pull_request);

    if (res.data.length === 100) {
      log("warn", "github_service.list_issues.truncated", {
        repo: `${this.repo.owner}/${this.repo.repo}`,
        state,
        note: "fetched exactly 100 issues; issues beyond the first page are not processed in this cycle"
      });
    }

    const result: Issue[] = [];
    for (const i of raw) {
      const labels = normalizeLabels(i.labels as unknown[]);
      const issueState = resolveState(state, labels, this.cfg);
      if (issueState === null) continue;
      const issue: Issue = {
        number: i.number,
        url: i.html_url,
        title: i.title ?? "",
        body: i.body ?? "",
        state: issueState,
        labels
      };
      if (labels.some((l) => l.toLowerCase() === this.cfg.LABEL_HUMAN_NEEDED.toLowerCase())) {
        issue.prReviewOutcome = "human_needed";
      }
      result.push(issue);
    }
    return result;
  }

  async transitionTo(
    issue: Issue,
    newState: IssueState,
    opts?: { closeReason?: CloseReason; prReviewOutcome?: PrReviewOutcome }
  ): Promise<void> {
    if (newState === "in_progress") {
      await this.addLabel(issue.number, this.cfg.LABEL_IN_PROGRESS);
    } else if (newState === "pr_reviewed") {
      await this.addLabel(issue.number, this.cfg.LABEL_PR_REVIEWED);
      // Remove all predecessor labels so closed/human-audited issues stay clean.
      await this.removeLabel(issue.number, this.cfg.LABEL_IN_REVIEW);
      await this.removeLabel(issue.number, this.cfg.LABEL_PR_CREATED);
      await this.removeLabel(issue.number, this.cfg.LABEL_IN_PROGRESS);
      if (opts?.prReviewOutcome === "human_needed") {
        await this.addLabel(issue.number, this.cfg.LABEL_HUMAN_NEEDED);
      }
    } else if (newState === "closed") {
      // Remove all state labels so the issue is clean after close.
      // The in-progress and pr-created labels are normally removed earlier in the pipeline,
      // but we defensively clean them here in case the issue was manually labelled out-of-order.
      await this.removeLabel(issue.number, this.cfg.LABEL_IN_PROGRESS);
      await this.removeLabel(issue.number, this.cfg.LABEL_PR_CREATED);
      await this.removeLabel(issue.number, this.cfg.LABEL_PR_REVIEWED);
      await this.removeLabel(issue.number, this.cfg.LABEL_HUMAN_NEEDED);
      await this.octokit.issues.update({
        owner: this.repo.owner,
        repo: this.repo.repo,
        issue_number: issue.number,
        state: "closed",
        state_reason: opts?.closeReason ?? "completed"
      });
    } else if (newState === "pr_created") {
      // The pr_created state is set externally by the worker via the pr-created label.
      // Calling transitionTo with this state is not supported from the orchestrator.
      throw new Error(`transitionTo("pr_created") is not supported; the worker sets the "${this.cfg.LABEL_PR_CREATED}" label directly`);
    } else if (newState === "open") {
      throw new Error(`transitionTo("open") is not supported; issues revert to open by removing all state labels`);
    }
  }

  async findLinkedPr(issue: Issue): Promise<PrInfo | null> {
    const query = `
      query FindLinkedPr($owner: String!, $repo: String!, $issue: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issue) {
            timelineItems(first: 50, itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT]) {
              nodes {
                __typename
                ... on ConnectedEvent {
                  subject {
                    ... on PullRequest {
                      number
                      url
                      headRefName
                      baseRefName
                      state
                    }
                  }
                }
                ... on CrossReferencedEvent {
                  source {
                    ... on PullRequest {
                      number
                      url
                      headRefName
                      baseRefName
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await this.octokit.graphql<any>(query, {
      owner: this.repo.owner,
      repo: this.repo.repo,
      issue: issue.number
    });

    const nodes: unknown[] = data?.repository?.issue?.timelineItems?.nodes ?? [];
    const openPrs: PrInfo[] = [];

    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const n = node as Record<string, unknown>;
      let pr: Record<string, unknown> | null = null;
      if (n.__typename === "ConnectedEvent") {
        pr = (n.subject as Record<string, unknown>) ?? null;
      } else if (n.__typename === "CrossReferencedEvent") {
        pr = (n.source as Record<string, unknown>) ?? null;
      }
      if (pr && pr.state === "OPEN" && typeof pr.number === "number") {
        openPrs.push({
          number: pr.number,
          url: pr.url as string,
          branch: pr.headRefName as string,
          baseBranch: pr.baseRefName as string
        });
      }
    }

    if (openPrs.length === 0) return null;
    // When multiple open PRs are linked, return the last one found (most recently linked).
    // Having more than one open PR for a single issue is abnormal; the worker always opens
    // exactly one PR per issue, so this is a safety fallback rather than a common path.
    return openPrs[openPrs.length - 1]!;
  }

  async mergePr(pr: PrInfo): Promise<void> {
    try {
      await this.octokit.pulls.merge({
        owner: this.repo.owner,
        repo: this.repo.repo,
        pull_number: pr.number,
        merge_method: this.cfg.PR_MERGE_METHOD
      });
    } catch (err: unknown) {
      // GitHub returns 405 when the PR is already merged. Treat that as a
      // successful no-op so the orchestrator can still close the issue.
      if ((err as { status?: number })?.status === 405) return;
      throw err;
    }
  }

  async isMentionedByWorker(issue: Issue): Promise<boolean> {
    if (containsMention(issue.body, this.cfg.WORKER_MENTION)) return true;

    const comments = await this.octokit.issues.listComments({
      owner: this.repo.owner,
      repo: this.repo.repo,
      issue_number: issue.number,
      per_page: 100
    });
    if (comments.data.length === 100) {
      log("warn", "github_service.list_comments.truncated", {
        repo: `${this.repo.owner}/${this.repo.repo}`,
        issue: issue.number,
        note: "fetched exactly 100 comments; additional comments are not checked for worker mentions"
      });
    }
    for (const c of comments.data) {
      if (containsMention(c.body ?? "", this.cfg.WORKER_MENTION)) return true;
    }
    return false;
  }

  async isInReview(issue: Issue): Promise<boolean> {
    return issue.labels.some((l) => l.toLowerCase() === this.cfg.LABEL_IN_REVIEW.toLowerCase());
  }

  async markInReview(issue: Issue): Promise<void> {
    await this.addLabel(issue.number, this.cfg.LABEL_IN_REVIEW);
  }

  private async addLabel(issueNumber: number, label: string): Promise<void> {
    await this.octokit.issues.addLabels({
      owner: this.repo.owner,
      repo: this.repo.repo,
      issue_number: issueNumber,
      labels: [label]
    });
  }

  private async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.removeLabel({
        owner: this.repo.owner,
        repo: this.repo.repo,
        issue_number: issueNumber,
        name: label
      });
    } catch (err: unknown) {
      if ((err as { status?: number })?.status !== 404) throw err;
    }
  }
}

function resolveState(requested: IssueState, labels: string[], cfg: Config): IssueState | null {
  if (requested === "closed") return "closed";

  const has = (label: string) => labels.some((l) => l.toLowerCase() === label.toLowerCase());

  const inProgress = has(cfg.LABEL_IN_PROGRESS);
  const prCreated = has(cfg.LABEL_PR_CREATED);
  const prReviewed = has(cfg.LABEL_PR_REVIEWED);

  if (requested === "open") {
    return !inProgress && !prCreated && !prReviewed ? "open" : null;
  }
  if (requested === "in_progress") {
    return inProgress ? "in_progress" : null;
  }
  if (requested === "pr_created") {
    return prCreated ? "pr_created" : null;
  }
  if (requested === "pr_reviewed") {
    return prReviewed ? "pr_reviewed" : null;
  }
  return null;
}

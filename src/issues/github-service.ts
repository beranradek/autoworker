import type { Octokit } from "@octokit/rest";
import type { CloseReason, Issue, IssueState, PrInfo, PrReviewOutcome } from "./model.js";
import type { IssueService } from "./service.js";
import type { RepoRef } from "../github/types.js";
import type { Config } from "../config.js";
import { containsMention } from "../github/mentions.js";

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
      await this.removeLabel(issue.number, this.cfg.LABEL_PR_REVIEW_DISPATCHED);
      if (opts?.prReviewOutcome === "human_needed") {
        await this.addLabel(issue.number, this.cfg.LABEL_HUMAN_NEEDED);
      }
    } else if (newState === "closed") {
      await this.octokit.issues.update({
        owner: this.repo.owner,
        repo: this.repo.repo,
        issue_number: issue.number,
        state: "closed",
        state_reason: opts?.closeReason ?? "completed"
      });
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
    return openPrs[openPrs.length - 1]!;
  }

  async mergePr(pr: PrInfo): Promise<void> {
    await this.octokit.pulls.merge({
      owner: this.repo.owner,
      repo: this.repo.repo,
      pull_number: pr.number,
      merge_method: this.cfg.PR_MERGE_METHOD
    });
  }

  async isMentionedByWorker(issue: Issue): Promise<boolean> {
    if (containsMention(issue.body, this.cfg.WORKER_MENTION)) return true;

    const comments = await this.octokit.issues.listComments({
      owner: this.repo.owner,
      repo: this.repo.repo,
      issue_number: issue.number,
      per_page: 100
    });
    for (const c of comments.data) {
      if (containsMention(c.body ?? "", this.cfg.WORKER_MENTION)) return true;
    }
    return false;
  }

  async isPrReviewDispatched(issue: Issue): Promise<boolean> {
    return issue.labels.some((l) => l.toLowerCase() === this.cfg.LABEL_PR_REVIEW_DISPATCHED.toLowerCase());
  }

  async markPrReviewDispatched(issue: Issue): Promise<void> {
    await this.addLabel(issue.number, this.cfg.LABEL_PR_REVIEW_DISPATCHED);
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

function normalizeLabels(labels: unknown[]): string[] {
  const out: string[] = [];
  for (const l of labels) {
    if (typeof l === "string") out.push(l);
    else if (l && typeof l === "object" && "name" in l && typeof (l as Record<string, unknown>).name === "string") {
      out.push((l as Record<string, unknown>).name as string);
    }
  }
  return out;
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

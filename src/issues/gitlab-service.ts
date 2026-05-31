import type { Config } from "../config.js";
import { log } from "../log.js";
import { containsMention } from "../github/mentions.js";
import type { GitLabClient } from "../gitlab/client.js";
import { paginateGitLab } from "../gitlab/client.js";
import type { CloseReason, Issue, IssueState, PendingIssueInfo, PrInfo, PrReviewOutcome } from "./model.js";
import type { IssueService } from "./service.js";

type GitLabLabel = { name: string };

type GitLabIssue = {
  iid: number;
  title?: string;
  description?: string | null;
  web_url: string;
  state: "opened" | "closed";
  labels?: string[];
};

type GitLabIssueNote = {
  body?: string | null;
  system?: boolean;
};

type GitLabMergeRequest = {
  iid: number;
  web_url: string;
  source_branch: string;
  target_branch: string;
  state: "opened" | "closed" | "merged" | string;
};

type GitLabIssueLink = {
  link_type: string;
  issue: { iid: number; state: "opened" | "closed" };
};

function resolveState(requested: IssueState, labels: string[], cfg: Config): IssueState | null {
  if (requested === "closed") return "closed";

  const has = (label: string) => labels.some((l) => l.toLowerCase() === label.toLowerCase());
  const inProgress = has(cfg.LABEL_IN_PROGRESS);
  const prCreated = has(cfg.LABEL_PR_CREATED);
  const prReviewed = has(cfg.LABEL_PR_REVIEWED);
  const inReview = has(cfg.LABEL_IN_REVIEW);

  if (requested === "open") {
    return !inProgress && !prCreated && !prReviewed && !inReview ? "open" : null;
  }
  if (requested === "in_progress") {
    return inProgress && !prCreated && !prReviewed && !inReview ? "in_progress" : null;
  }
  if (requested === "pr_created") {
    return prCreated && !inReview && !prReviewed ? "pr_created" : null;
  }
  if (requested === "pr_reviewed") {
    return prReviewed ? "pr_reviewed" : null;
  }
  return null;
}

const COLOR_IN_PROGRESS = "#e4e669";
const COLOR_FAILED = "#d93f0b";
const COLOR_PR_CREATED = "#0e8a16";
const COLOR_IN_REVIEW = "#bfd4f2";
const COLOR_PR_REVIEWED = "#c2e0c6";
const COLOR_HUMAN_NEEDED = "#f9d0c4";

export class GitLabIssueService implements IssueService {
  private dependencyApiUnavailableLogged = false;

  constructor(
    private readonly client: GitLabClient,
    private readonly projectPath: string, // URL-encoded "owner/repo"
    private readonly cfg: Config
  ) {}

  async ensureLabels(): Promise<void> {
    const needed = [
      { name: this.cfg.LABEL_IN_PROGRESS, color: COLOR_IN_PROGRESS, description: "Worker is implementing this issue" },
      { name: this.cfg.LABEL_FAILED, color: COLOR_FAILED, description: "Worker failed to process this issue" },
      { name: this.cfg.LABEL_PR_CREATED, color: COLOR_PR_CREATED, description: "Worker created a PR/MR for this issue" },
      { name: this.cfg.LABEL_IN_REVIEW, color: COLOR_IN_REVIEW, description: "Worker is reviewing the MR" },
      { name: this.cfg.LABEL_PR_REVIEWED, color: COLOR_PR_REVIEWED, description: "Worker reviewed the MR" },
      { name: this.cfg.LABEL_HUMAN_NEEDED, color: COLOR_HUMAN_NEEDED, description: "Human review needed" },
      { name: "wontfix", color: "#ffffff", description: "This will not be worked on" },
      { name: "invalid", color: COLOR_IN_PROGRESS, description: "This doesn't seem right" },
      { name: "duplicate", color: "#cfd3d7", description: "This issue or MR already exists" },
      { name: "help wanted", color: "#008672", description: "Extra attention is needed" },
      { name: "question", color: "#d876e3", description: "Further information is requested" },
    ];

    const existing = await paginateGitLab<GitLabLabel>(this.client, `projects/${this.projectPath}/labels`);
    const existingNames = new Set(existing.map((l) => (l.name ?? "").toLowerCase()));

    for (const label of needed) {
      if (existingNames.has(label.name.toLowerCase())) continue;
      await this.client.requestNoBody("POST", `projects/${this.projectPath}/labels`, {
        body: { name: label.name, color: label.color, description: label.description }
      });
      log("info", "label.created", { project: this.projectPath, label: label.name, provider: "gitlab" });
    }
  }

  async listIssuesByState(state: IssueState): Promise<Issue[]> {
    const apiState = state === "closed" ? "closed" : "opened";
    const items = await paginateGitLab<GitLabIssue>(this.client, `projects/${this.projectPath}/issues`, { state: apiState });

    const result: Issue[] = [];
    for (const i of items) {
      const labels = (i.labels ?? []).map(String);
      const issueState = resolveState(state, labels, this.cfg);
      if (issueState === null) continue;
      const issue: Issue = {
        number: i.iid,
        url: i.web_url,
        title: i.title ?? "",
        body: i.description ?? "",
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

  async listPendingIssues(): Promise<PendingIssueInfo[]> {
    const pending = await this.listIssuesByState("open");

    const blockedByOpen = new Map<number, number[]>();

    const CONCURRENCY = 8;
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
      while (true) {
        const i = idx++;
        if (i >= pending.length) return;
        const issue = pending[i]!;
        const deps = await this.listOpenBlockedBy(issue.number);
        blockedByOpen.set(issue.number, deps);
      }
    });
    await Promise.all(workers);

    const blocksCount = new Map<number, number>();
    for (const deps of blockedByOpen.values()) {
      for (const dep of deps) {
        blocksCount.set(dep, (blocksCount.get(dep) ?? 0) + 1);
      }
    }

    const infos: PendingIssueInfo[] = pending.map((issue) => {
      const blockedBy = blockedByOpen.get(issue.number) ?? [];
      return {
        number: issue.number,
        url: issue.url,
        title: issue.title,
        blockedBy,
        ready: blockedBy.length === 0,
        blocksCount: blocksCount.get(issue.number) ?? 0
      };
    });

    infos.sort((a, b) => {
      if (a.ready !== b.ready) return a.ready ? -1 : 1;
      if (a.blocksCount !== b.blocksCount) return b.blocksCount - a.blocksCount;
      return a.number - b.number;
    });
    return infos;
  }

  async transitionTo(
    issue: Issue,
    newState: IssueState,
    opts?: { closeReason?: CloseReason; prReviewOutcome?: PrReviewOutcome }
  ): Promise<void> {
    if (newState === "in_progress") {
      await this.addLabel(issue.number, this.cfg.LABEL_IN_PROGRESS);
      return;
    }
    if (newState === "pr_reviewed") {
      await this.addLabel(issue.number, this.cfg.LABEL_PR_REVIEWED);
      await this.removeLabel(issue.number, this.cfg.LABEL_IN_REVIEW);
      await this.removeLabel(issue.number, this.cfg.LABEL_PR_CREATED);
      await this.removeLabel(issue.number, this.cfg.LABEL_IN_PROGRESS);
      if (opts?.prReviewOutcome === "human_needed") {
        await this.addLabel(issue.number, this.cfg.LABEL_HUMAN_NEEDED);
      }
      return;
    }
    if (newState === "closed") {
      await this.removeLabel(issue.number, this.cfg.LABEL_IN_PROGRESS);
      await this.removeLabel(issue.number, this.cfg.LABEL_PR_CREATED);
      await this.removeLabel(issue.number, this.cfg.LABEL_PR_REVIEWED);
      await this.removeLabel(issue.number, this.cfg.LABEL_HUMAN_NEEDED);
      // Close the issue.
      await this.client.requestNoBody("PUT", `projects/${this.projectPath}/issues/${issue.number}`, {
        body: { state_event: "close", state_reason: opts?.closeReason ?? "completed" }
      });
      return;
    }
    if (newState === "pr_created") {
      throw new Error(`transitionTo("pr_created") is not supported; the worker sets the "${this.cfg.LABEL_PR_CREATED}" label directly`);
    }
    if (newState === "open") {
      throw new Error(`transitionTo("open") is not supported; issues revert to open by removing all state labels`);
    }
  }

  async findLinkedPr(issue: Issue): Promise<PrInfo | null> {
    const res = await this.client.requestJson<GitLabMergeRequest[]>(
      "GET",
      `projects/${this.projectPath}/issues/${issue.number}/related_merge_requests`
    );
    const open = (res.data ?? []).filter((mr) => String(mr.state).toLowerCase() === "opened");
    if (open.length === 0) return null;
    const last = open[open.length - 1]!;
    return {
      number: last.iid,
      url: last.web_url,
      branch: last.source_branch,
      baseBranch: last.target_branch
    };
  }

  async mergePr(pr: PrInfo): Promise<void> {
    // Merge request IID is `number`.
    await this.client.requestNoBody("PUT", `projects/${this.projectPath}/merge_requests/${pr.number}/merge`);
  }

  async isMentionedByWorker(issue: Issue): Promise<boolean> {
    if (containsMention(issue.body, this.cfg.WORKER_MENTION)) return true;
    const notes = await paginateGitLab<GitLabIssueNote>(this.client, `projects/${this.projectPath}/issues/${issue.number}/notes`);
    for (const n of notes) {
      if (n.system) continue;
      if (containsMention(n.body ?? "", this.cfg.WORKER_MENTION)) return true;
    }
    return false;
  }

  async isInReview(issue: Issue): Promise<boolean> {
    return issue.labels.some((l) => l.toLowerCase() === this.cfg.LABEL_IN_REVIEW.toLowerCase());
  }

  async markInReview(issue: Issue): Promise<void> {
    await this.addLabel(issue.number, this.cfg.LABEL_IN_REVIEW);
  }

  async unmarkInReview(issue: Issue): Promise<void> {
    await this.removeLabel(issue.number, this.cfg.LABEL_IN_REVIEW);
  }

  async unmarkInProgress(issue: Issue): Promise<void> {
    await this.removeLabel(issue.number, this.cfg.LABEL_IN_PROGRESS);
  }

  private async addLabel(issueIid: number, label: string): Promise<void> {
    await this.client.requestNoBody("PUT", `projects/${this.projectPath}/issues/${issueIid}`, {
      body: { add_labels: label }
    });
  }

  private async removeLabel(issueIid: number, label: string): Promise<void> {
    await this.client.requestNoBody("PUT", `projects/${this.projectPath}/issues/${issueIid}`, {
      body: { remove_labels: label }
    });
  }

  private async listOpenBlockedBy(issueIid: number): Promise<number[]> {
    try {
      const links = await this.client.requestJson<GitLabIssueLink[]>(
        "GET",
        `projects/${this.projectPath}/issues/${issueIid}/links`
      );
      const deps = (links.data ?? [])
        .filter((l) => l && (l as any).link_type === "is_blocked_by")
        .map((l) => (l as any).issue)
        .filter((i) => i && i.state !== "closed")
        .map((i) => i.iid)
        .filter((n) => typeof n === "number");
      return deps;
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (!this.dependencyApiUnavailableLogged) {
        this.dependencyApiUnavailableLogged = true;
        log("warn", "gitlab_service.issue_dependencies.unavailable", {
          project: this.projectPath,
          status: status ?? null,
          note: "Issue links API unavailable; treating all issues as unblocked"
        });
      }
      return [];
    }
  }
}


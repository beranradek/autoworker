import type { Octokit } from "@octokit/rest";
import type { IssueCandidate, RepoRef } from "./types.js";
import { containsMention } from "./mentions.js";

export function normalizeLabels(labels: unknown[]): string[] {
  const out: string[] = [];
  for (const l of labels) {
    if (typeof l === "string") out.push(l);
    else if (l && typeof l === "object" && "name" in l && typeof (l as any).name === "string") out.push((l as any).name);
  }
  return out;
}

export async function listOpenIssues(octokit: Octokit, repo: RepoRef): Promise<IssueCandidate[]> {
  const res = await octokit.issues.listForRepo({
    owner: repo.owner,
    repo: repo.repo,
    state: "open",
    per_page: 50,
    sort: "created",
    direction: "desc"
  });

  return res.data
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      url: i.html_url,
      title: i.title ?? "",
      body: i.body ?? "",
      labels: normalizeLabels(i.labels as any)
    }));
}

export function hasAnyLabel(issue: IssueCandidate, labels: string[]): boolean {
  const have = new Set(issue.labels.map((l) => l.toLowerCase()));
  return labels.some((l) => have.has(l.toLowerCase()));
}

export async function issueMentionsWorker(
  octokit: Octokit,
  repo: RepoRef,
  issue: IssueCandidate,
  mention: string
): Promise<boolean> {
  if (containsMention(issue.body, mention)) return true;

  const comments = await octokit.issues.listComments({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: issue.number,
    per_page: 100
  });
  for (const c of comments.data) {
    if (containsMention(c.body ?? "", mention)) return true;
  }
  return false;
}

export const ACCEPT_MARKER = "<!-- autoworker:accepted -->";

export async function hasAcceptanceMarker(octokit: Octokit, repo: RepoRef, issueNumber: number): Promise<boolean> {
  const comments = await octokit.issues.listComments({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: issueNumber,
    per_page: 100
  });
  return comments.data.some((c) => (c.body ?? "").includes(ACCEPT_MARKER));
}

export async function commentAccepted(
  octokit: Octokit,
  repo: RepoRef,
  issueNumber: number,
  message: string
): Promise<void> {
  await octokit.issues.createComment({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: issueNumber,
    body: `${ACCEPT_MARKER}\n${message}`
  });
}

export async function addLabel(octokit: Octokit, repo: RepoRef, issueNumber: number, label: string): Promise<void> {
  await octokit.issues.addLabels({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: issueNumber,
    labels: [label]
  });
}


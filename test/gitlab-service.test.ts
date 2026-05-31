import { describe, expect, it, vi } from "vitest";
import type { GitLabClient } from "../src/gitlab/client.js";
import { GitLabIssueService } from "../src/issues/gitlab-service.js";

function makeClient(routes: Record<string, any>): GitLabClient {
  return {
    baseUrl: "https://gitlab.example.com/api/v4/",
    requestJson: vi.fn().mockImplementation(async (_method: any, path: string) => {
      const data = routes[path] ?? [];
      return { data, headers: new Headers() };
    }),
    requestNoBody: vi.fn().mockResolvedValue({ headers: new Headers() }),
  };
}

function makeCfg(overrides: Partial<any> = {}) {
  return {
    WORKER_MENTION: "@worker",
    LABEL_IN_PROGRESS: "in-progress",
    LABEL_FAILED: "worker-failed",
    LABEL_PR_CREATED: "pr-created",
    LABEL_IN_REVIEW: "in-review",
    LABEL_PR_REVIEWED: "pr-reviewed",
    LABEL_HUMAN_NEEDED: "human-needed",
    PR_MERGE_METHOD: "squash",
    ...overrides
  };
}

describe("GitLabIssueService", () => {
  it("listIssuesByState('open') excludes issues with orchestrator labels", async () => {
    const client = makeClient({
      "projects/o%2Fr/issues": [
        { iid: 1, web_url: "u1", state: "opened", title: "a", description: "", labels: [] },
        { iid: 2, web_url: "u2", state: "opened", title: "b", description: "", labels: ["in-progress"] },
      ]
    });
    const svc = new GitLabIssueService(client, "o%2Fr", makeCfg());
    const res = await svc.listIssuesByState("open");
    expect(res.map((i) => i.number)).toEqual([1]);
  });

  it("listPendingIssues treats open is_blocked_by links as blockers", async () => {
    const client = makeClient({
      "projects/o%2Fr/issues": [
        { iid: 1, web_url: "u1", state: "opened", title: "a", description: "", labels: [] },
        { iid: 2, web_url: "u2", state: "opened", title: "b", description: "", labels: [] },
      ],
      "projects/o%2Fr/issues/1/links": [],
      "projects/o%2Fr/issues/2/links": [
        { link_type: "is_blocked_by", issue: { iid: 1, state: "opened" } }
      ],
    });
    const svc = new GitLabIssueService(client, "o%2Fr", makeCfg());
    const res = await svc.listPendingIssues();
    expect(res.map((i) => i.number)).toEqual([1, 2]);
    expect(res[0]).toMatchObject({ ready: true, blocksCount: 1 });
    expect(res[1]).toMatchObject({ ready: false, blockedBy: [1] });
  });

  it("findLinkedPr returns last opened merge request", async () => {
    const client = makeClient({
      "projects/o%2Fr/issues/7/related_merge_requests": [
        { iid: 1, web_url: "mr1", source_branch: "a", target_branch: "main", state: "closed" },
        { iid: 2, web_url: "mr2", source_branch: "b", target_branch: "main", state: "opened" },
      ],
    });
    const svc = new GitLabIssueService(client, "o%2Fr", makeCfg());
    const pr = await svc.findLinkedPr({ number: 7, url: "u", title: "", body: "", state: "open", labels: [] });
    expect(pr).toMatchObject({ number: 2, url: "mr2", branch: "b", baseBranch: "main" });
  });
});


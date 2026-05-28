import { describe, expect, it, vi } from "vitest";
import { GitHubIssueService } from "../src/issues/github-service.js";
import type { Issue, PrInfo } from "../src/issues/model.js";

function makeOctokit(overrides: Partial<any> = {}): any {
  return {
    issues: {
      listForRepo: vi.fn().mockResolvedValue({ data: [] }),
      addLabels: vi.fn().mockResolvedValue({}),
      removeLabel: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      listComments: vi.fn().mockResolvedValue({ data: [] }),
    },
    pulls: {
      merge: vi.fn().mockResolvedValue({}),
    },
    graphql: vi.fn().mockResolvedValue({ repository: { issue: { timelineItems: { nodes: [] } } } }),
    ...overrides,
  };
}

function makeConfig(overrides = {}): any {
  return {
    WORKER_MENTION: "@worker",
    LABEL_IN_PROGRESS: "in-progress",
    LABEL_PR_CREATED: "pr-created",
    LABEL_PR_REVIEWED: "pr-reviewed",
    LABEL_HUMAN_NEEDED: "human-needed",
    LABEL_IN_REVIEW: "in-review",
    PR_MERGE_METHOD: "squash",
    ...overrides,
  };
}

const repo = { owner: "o", repo: "r" };

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    url: "https://github.com/o/r/issues/1",
    title: "Test issue",
    body: "",
    state: "open",
    labels: [],
    ...overrides,
  };
}

function makeApiIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 1,
    html_url: "https://github.com/o/r/issues/1",
    title: "Test issue",
    body: "",
    labels: [],
    ...overrides,
  };
}

describe("GitHubIssueService – listIssuesByState", () => {
  it("'open' returns only issues without in-progress/pr-created/pr-reviewed labels", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [
            makeApiIssue({ number: 1, labels: [] }),
            makeApiIssue({ number: 2, labels: [{ name: "in-progress" }] }),
            makeApiIssue({ number: 3, labels: [{ name: "pr-created" }] }),
          ],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("open");
    expect(result).toHaveLength(1);
    expect(result[0]!.number).toBe(1);
  });

  it("'pr_created' returns only issues with pr-created label", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [
            makeApiIssue({ number: 1, labels: [] }),
            makeApiIssue({ number: 2, labels: [{ name: "pr-created" }] }),
            makeApiIssue({ number: 3, labels: [{ name: "in-progress" }] }),
          ],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("pr_created");
    expect(result).toHaveLength(1);
    expect(result[0]!.number).toBe(2);
    expect(result[0]!.state).toBe("pr_created");
  });

  it("'pr_reviewed' with human-needed label sets prReviewOutcome: 'human_needed'", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [
            makeApiIssue({ number: 1, labels: [{ name: "pr-reviewed" }, { name: "human-needed" }] }),
          ],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("pr_reviewed");
    expect(result).toHaveLength(1);
    expect(result[0]!.prReviewOutcome).toBe("human_needed");
  });

  it("filters out pull requests (items with pull_request field truthy)", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [
            makeApiIssue({ number: 1, labels: [] }),
            makeApiIssue({ number: 2, labels: [], pull_request: { url: "https://..." } }),
          ],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("open");
    expect(result).toHaveLength(1);
    expect(result[0]!.number).toBe(1);
  });
});

describe("GitHubIssueService – resolveState (via listIssuesByState)", () => {
  it("issue with in-progress label does NOT appear in listIssuesByState('open')", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [makeApiIssue({ number: 1, labels: [{ name: "in-progress" }] })],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("open");
    expect(result).toHaveLength(0);
  });

  it("issue with pr-created label does NOT appear in listIssuesByState('open')", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [makeApiIssue({ number: 1, labels: [{ name: "pr-created" }] })],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("open");
    expect(result).toHaveLength(0);
  });

  it("issue with pr-reviewed + human-needed does NOT appear in listIssuesByState('open')", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [makeApiIssue({ number: 1, labels: [{ name: "pr-reviewed" }, { name: "human-needed" }] })],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("open");
    expect(result).toHaveLength(0);
  });

  it("issue with in-review label does NOT appear in listIssuesByState('open')", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [makeApiIssue({ number: 1, labels: [{ name: "in-review" }] })],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("open");
    expect(result).toHaveLength(0);
  });

  it("issue with pr-created + in-review labels does NOT appear in listIssuesByState('open')", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [makeApiIssue({ number: 1, labels: [{ name: "pr-created" }, { name: "in-review" }] })],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("open");
    expect(result).toHaveLength(0);
  });

  it("issue with both in-progress and pr-created does NOT appear in listIssuesByState('in_progress') — pr-created takes priority", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [makeApiIssue({ number: 1, labels: [{ name: "in-progress" }, { name: "pr-created" }] })],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("in_progress");
    expect(result).toHaveLength(0);
  });

  it("issue with both in-progress and pr-created appears in listIssuesByState('pr_created')", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [makeApiIssue({ number: 1, labels: [{ name: "in-progress" }, { name: "pr-created" }] })],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("pr_created");
    expect(result).toHaveLength(1);
    expect(result[0]!.state).toBe("pr_created");
  });

  it("issue with pr-created and in-review does NOT appear in listIssuesByState('pr_created') — in-review takes priority", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [makeApiIssue({ number: 1, labels: [{ name: "pr-created" }, { name: "in-review" }] })],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("pr_created");
    expect(result).toHaveLength(0);
  });

  it("issue with pr-created and pr-reviewed does NOT appear in listIssuesByState('pr_created') — pr-reviewed takes priority", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listForRepo: vi.fn().mockResolvedValue({
          data: [makeApiIssue({ number: 1, labels: [{ name: "pr-created" }, { name: "pr-reviewed" }] })],
        }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.listIssuesByState("pr_created");
    expect(result).toHaveLength(0);
  });
});

describe("GitHubIssueService – transitionTo", () => {
  it("'in_progress': calls addLabels with ['in-progress']", async () => {
    const octokit = makeOctokit();
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await svc.transitionTo(makeIssue(), "in_progress");
    expect(octokit.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["in-progress"] })
    );
  });

  it("'pr_reviewed' (approved): adds pr-reviewed, removes in-review, does NOT add human-needed", async () => {
    const octokit = makeOctokit();
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await svc.transitionTo(makeIssue(), "pr_reviewed");
    expect(octokit.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["pr-reviewed"] })
    );
    expect(octokit.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "in-review" })
    );
    const addCalls = octokit.issues.addLabels.mock.calls as any[][];
    const addedLabels = addCalls.flatMap((args) => args[0].labels);
    expect(addedLabels).not.toContain("human-needed");
  });

  it("'pr_reviewed' with prReviewOutcome 'human_needed': adds human-needed", async () => {
    const octokit = makeOctokit();
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await svc.transitionTo(makeIssue(), "pr_reviewed", { prReviewOutcome: "human_needed" });
    expect(octokit.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["human-needed"] })
    );
  });

  it("'pr_reviewed' removes pr-created and in-progress predecessor labels", async () => {
    const octokit = makeOctokit();
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await svc.transitionTo(makeIssue(), "pr_reviewed");
    expect(octokit.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pr-created" })
    );
    expect(octokit.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "in-progress" })
    );
  });

  it("'closed': calls issues.update with state 'closed' and state_reason 'completed' by default", async () => {
    const octokit = makeOctokit();
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await svc.transitionTo(makeIssue({ number: 7 }), "closed");
    expect(octokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: "closed", state_reason: "completed" })
    );
  });

  it("'closed': defensively removes all state labels including in-progress and pr-created", async () => {
    const octokit = makeOctokit();
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await svc.transitionTo(makeIssue({ number: 7 }), "closed");
    const removeCalls = (octokit.issues.removeLabel.mock.calls as any[][]).map((args) => args[0].name);
    expect(removeCalls).toContain("in-progress");
    expect(removeCalls).toContain("pr-created");
    expect(removeCalls).toContain("pr-reviewed");
    expect(removeCalls).toContain("human-needed");
  });

  it("'closed' with closeReason 'not_planned': uses state_reason 'not_planned'", async () => {
    const octokit = makeOctokit();
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await svc.transitionTo(makeIssue({ number: 7 }), "closed", { closeReason: "not_planned" });
    expect(octokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ state_reason: "not_planned" })
    );
  });

  it("removeLabel 404 is swallowed: transitionTo resolves without throwing", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        removeLabel: vi.fn().mockRejectedValue({ status: 404 }),
        addLabels: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await expect(svc.transitionTo(makeIssue(), "pr_reviewed")).resolves.toBeUndefined();
  });

  it("removeLabel non-404 error propagates", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        removeLabel: vi.fn().mockRejectedValue({ status: 403 }),
        addLabels: vi.fn().mockResolvedValue({}),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await expect(svc.transitionTo(makeIssue(), "pr_reviewed")).rejects.toMatchObject({ status: 403 });
  });
});

describe("GitHubIssueService – findLinkedPr", () => {
  it("returns null when GraphQL returns empty nodes", async () => {
    const svc = new GitHubIssueService(makeOctokit(), repo, makeConfig());
    const result = await svc.findLinkedPr(makeIssue());
    expect(result).toBeNull();
  });

  it("returns PR from CrossReferencedEvent when source.state === 'OPEN'", async () => {
    const octokit = makeOctokit({
      graphql: vi.fn().mockResolvedValue({
        repository: {
          issue: {
            timelineItems: {
              nodes: [
                {
                  __typename: "CrossReferencedEvent",
                  source: {
                    number: 42,
                    url: "https://github.com/o/r/pull/42",
                    headRefName: "feat/thing",
                    baseRefName: "main",
                    state: "OPEN",
                  },
                },
              ],
            },
          },
        },
      }),
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.findLinkedPr(makeIssue());
    expect(result).toEqual<PrInfo>({
      number: 42,
      url: "https://github.com/o/r/pull/42",
      branch: "feat/thing",
      baseBranch: "main",
    });
  });

  it("returns PR from ConnectedEvent when subject.state === 'OPEN'", async () => {
    const octokit = makeOctokit({
      graphql: vi.fn().mockResolvedValue({
        repository: {
          issue: {
            timelineItems: {
              nodes: [
                {
                  __typename: "ConnectedEvent",
                  subject: {
                    number: 55,
                    url: "https://github.com/o/r/pull/55",
                    headRefName: "fix/bug",
                    baseRefName: "main",
                    state: "OPEN",
                  },
                },
              ],
            },
          },
        },
      }),
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.findLinkedPr(makeIssue());
    expect(result).toEqual<PrInfo>({
      number: 55,
      url: "https://github.com/o/r/pull/55",
      branch: "fix/bug",
      baseBranch: "main",
    });
  });

  it("skips CLOSED PRs from CrossReferencedEvent", async () => {
    const octokit = makeOctokit({
      graphql: vi.fn().mockResolvedValue({
        repository: {
          issue: {
            timelineItems: {
              nodes: [
                {
                  __typename: "CrossReferencedEvent",
                  source: {
                    number: 10,
                    url: "https://github.com/o/r/pull/10",
                    headRefName: "old-branch",
                    baseRefName: "main",
                    state: "CLOSED",
                  },
                },
              ],
            },
          },
        },
      }),
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.findLinkedPr(makeIssue());
    expect(result).toBeNull();
  });

  it("skips MERGED PRs from ConnectedEvent", async () => {
    const octokit = makeOctokit({
      graphql: vi.fn().mockResolvedValue({
        repository: {
          issue: {
            timelineItems: {
              nodes: [
                {
                  __typename: "ConnectedEvent",
                  subject: {
                    number: 20,
                    url: "https://github.com/o/r/pull/20",
                    headRefName: "merged-branch",
                    baseRefName: "main",
                    state: "MERGED",
                  },
                },
              ],
            },
          },
        },
      }),
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.findLinkedPr(makeIssue());
    expect(result).toBeNull();
  });

  it("when multiple OPEN PRs exist, returns the last one", async () => {
    const octokit = makeOctokit({
      graphql: vi.fn().mockResolvedValue({
        repository: {
          issue: {
            timelineItems: {
              nodes: [
                {
                  __typename: "ConnectedEvent",
                  subject: {
                    number: 30,
                    url: "https://github.com/o/r/pull/30",
                    headRefName: "first-branch",
                    baseRefName: "main",
                    state: "OPEN",
                  },
                },
                {
                  __typename: "CrossReferencedEvent",
                  source: {
                    number: 31,
                    url: "https://github.com/o/r/pull/31",
                    headRefName: "second-branch",
                    baseRefName: "main",
                    state: "OPEN",
                  },
                },
              ],
            },
          },
        },
      }),
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.findLinkedPr(makeIssue());
    expect(result!.number).toBe(31);
  });

  it("mixed events: CLOSED CrossReferencedEvent + OPEN ConnectedEvent returns ConnectedEvent PR", async () => {
    const octokit = makeOctokit({
      graphql: vi.fn().mockResolvedValue({
        repository: {
          issue: {
            timelineItems: {
              nodes: [
                {
                  __typename: "CrossReferencedEvent",
                  source: {
                    number: 40,
                    url: "https://github.com/o/r/pull/40",
                    headRefName: "closed-branch",
                    baseRefName: "main",
                    state: "CLOSED",
                  },
                },
                {
                  __typename: "ConnectedEvent",
                  subject: {
                    number: 41,
                    url: "https://github.com/o/r/pull/41",
                    headRefName: "open-branch",
                    baseRefName: "main",
                    state: "OPEN",
                  },
                },
              ],
            },
          },
        },
      }),
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const result = await svc.findLinkedPr(makeIssue());
    expect(result!.number).toBe(41);
  });
});

describe("GitHubIssueService – mergePr", () => {
  const pr: PrInfo = { number: 99, url: "https://github.com/o/r/pull/99", branch: "feat/x", baseBranch: "main" };

  it("happy path: calls pulls.merge with correct params", async () => {
    const octokit = makeOctokit();
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await svc.mergePr(pr);
    expect(octokit.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 99, merge_method: "squash" })
    );
  });

  it("405 'already merged' is swallowed: resolves without throwing", async () => {
    const octokit = makeOctokit({
      pulls: { merge: vi.fn().mockRejectedValue({ status: 405 }) },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await expect(svc.mergePr(pr)).resolves.toBeUndefined();
  });

  it("422 'merge conflict' propagates", async () => {
    const octokit = makeOctokit({
      pulls: { merge: vi.fn().mockRejectedValue({ status: 422 }) },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await expect(svc.mergePr(pr)).rejects.toMatchObject({ status: 422 });
  });

  it("404 'not found' propagates", async () => {
    const octokit = makeOctokit({
      pulls: { merge: vi.fn().mockRejectedValue({ status: 404 }) },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    await expect(svc.mergePr(pr)).rejects.toMatchObject({ status: 404 });
  });
});

describe("GitHubIssueService – isMentionedByWorker", () => {
  it("returns true when issue body contains @worker", async () => {
    const svc = new GitHubIssueService(makeOctokit(), repo, makeConfig());
    const issue = makeIssue({ body: "Please fix this @worker" });
    const result = await svc.isMentionedByWorker(issue);
    expect(result).toBe(true);
  });

  it("returns false when body has no mention and no comments match", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listComments: vi.fn().mockResolvedValue({ data: [{ body: "No mention here" }] }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const issue = makeIssue({ body: "No mention here either" });
    const result = await svc.isMentionedByWorker(issue);
    expect(result).toBe(false);
  });

  it("returns true when a comment body contains @worker", async () => {
    const octokit = makeOctokit({
      issues: {
        ...makeOctokit().issues,
        listComments: vi.fn().mockResolvedValue({ data: [{ body: "hey @worker please do this" }] }),
      },
    });
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const issue = makeIssue({ body: "no mention in body" });
    const result = await svc.isMentionedByWorker(issue);
    expect(result).toBe(true);
  });
});

describe("GitHubIssueService – isInReview / markInReview", () => {
  it("isInReview returns true when labels contain in-review", async () => {
    const svc = new GitHubIssueService(makeOctokit(), repo, makeConfig());
    const issue = makeIssue({ labels: ["pr-created", "in-review"] });
    const result = await svc.isInReview(issue);
    expect(result).toBe(true);
  });

  it("isInReview returns false when labels do not contain in-review", async () => {
    const svc = new GitHubIssueService(makeOctokit(), repo, makeConfig());
    const issue = makeIssue({ labels: ["pr-created"] });
    const result = await svc.isInReview(issue);
    expect(result).toBe(false);
  });

  it("markInReview calls addLabels with ['in-review']", async () => {
    const octokit = makeOctokit();
    const svc = new GitHubIssueService(octokit, repo, makeConfig());
    const issue = makeIssue({ number: 5 });
    await svc.markInReview(issue);
    expect(octokit.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 5, labels: ["in-review"] })
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { runOrchestration } from "../src/runner/orchestrate.js";
import type { IssueService } from "../src/issues/service.js";
import type { JobRunner } from "../src/job-runner/types.js";
import type { Config } from "../src/config.js";
import type { Issue } from "../src/issues/model.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    GITHUB_TOKEN: "tok",
    GITHUB_REPOS: "owner/repo",
    JOB_RUNNER: "local-docker",
    WORKER_MENTION: "@worker",
    LABEL_IN_PROGRESS: "in-progress",
    LABEL_PR_CREATED: "pr-created",
    LABEL_PR_REVIEWED: "pr-reviewed",
    LABEL_HUMAN_NEEDED: "human-needed",
    LABEL_PR_REVIEW_DISPATCHED: "pr-review-dispatched",
    POLL_INTERVAL_SECONDS: 60,
    MAX_ACCEPT_PER_RUN: 5,
    DRY_RUN: false,
    STEP_PR_MERGE: false,
    STEP_PR_REVIEW: false,
    STEP_IMPLEMENTATION: true,
    PR_MERGE_METHOD: "squash",
    ACA_JOB_NAME: "issue-agent",
    LLM_MODEL: "openai/gpt-5-mini",
    WORKER_IMAGE: "worker:latest",
    CREATE_JOB_IF_MISSING: false,
    AZURE_USE_MANAGED_IDENTITY: false,
    ...overrides
  } as Config;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    url: "https://github.com/owner/repo/issues/1",
    title: "Test issue",
    body: "@worker please fix this",
    state: "open",
    labels: [],
    ...overrides
  };
}

function makeService(overrides: Partial<IssueService> = {}): IssueService {
  return {
    listIssuesByState: vi.fn().mockResolvedValue([]),
    transitionTo: vi.fn().mockResolvedValue(undefined),
    findLinkedPr: vi.fn().mockResolvedValue(null),
    mergePr: vi.fn().mockResolvedValue(undefined),
    isMentionedByWorker: vi.fn().mockResolvedValue(false),
    isPrReviewDispatched: vi.fn().mockResolvedValue(false),
    markPrReviewDispatched: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function makeRunner(overrides: Partial<JobRunner> = {}): JobRunner {
  return {
    runIssue: vi.fn().mockResolvedValue({ runner: "local-docker" }),
    runPrReview: vi.fn().mockResolvedValue({ runner: "local-docker" }),
    ...overrides
  };
}

describe("runOrchestration – STEP_IMPLEMENTATION", () => {
  it("calls listIssuesByState('open') when STEP_IMPLEMENTATION=true", async () => {
    const service = makeService({
      isMentionedByWorker: vi.fn().mockResolvedValue(true),
      listIssuesByState: vi.fn().mockResolvedValue([makeIssue()])
    });
    const runner = makeRunner();
    await runOrchestration(service, runner, makeConfig(), "owner/repo");
    expect(service.listIssuesByState).toHaveBeenCalledWith("open");
  });

  it("does NOT call listIssuesByState('open') when STEP_IMPLEMENTATION=false", async () => {
    const service = makeService();
    const runner = makeRunner();
    await runOrchestration(service, runner, makeConfig({ STEP_IMPLEMENTATION: false }), "owner/repo");
    expect(service.listIssuesByState).not.toHaveBeenCalledWith("open");
  });

  it("calls transitionTo and runIssue for a mentioned issue", async () => {
    const issue = makeIssue();
    const service = makeService({
      listIssuesByState: vi.fn().mockResolvedValue([issue]),
      isMentionedByWorker: vi.fn().mockResolvedValue(true)
    });
    const runner = makeRunner();
    await runOrchestration(service, runner, makeConfig(), "owner/repo");
    expect(service.transitionTo).toHaveBeenCalledWith(issue, "in_progress");
    expect(runner.runIssue).toHaveBeenCalledOnce();
    expect(runner.runIssue).toHaveBeenCalledWith(expect.objectContaining({ issueUrl: issue.url }));
  });

  it("does NOT call transitionTo or runIssue when issue is not mentioned", async () => {
    const issue = makeIssue();
    const service = makeService({
      listIssuesByState: vi.fn().mockResolvedValue([issue]),
      isMentionedByWorker: vi.fn().mockResolvedValue(false)
    });
    const runner = makeRunner();
    await runOrchestration(service, runner, makeConfig(), "owner/repo");
    expect(service.transitionTo).not.toHaveBeenCalled();
    expect(runner.runIssue).not.toHaveBeenCalled();
  });

  it("calls transitionTo but NOT runIssue when DRY_RUN=true", async () => {
    const issue = makeIssue();
    const service = makeService({
      listIssuesByState: vi.fn().mockResolvedValue([issue]),
      isMentionedByWorker: vi.fn().mockResolvedValue(true)
    });
    const runner = makeRunner();
    await runOrchestration(service, runner, makeConfig({ DRY_RUN: true }), "owner/repo");
    expect(service.transitionTo).toHaveBeenCalledWith(issue, "in_progress");
    expect(runner.runIssue).not.toHaveBeenCalled();
  });

  it("calls runIssue BEFORE transitionTo('in_progress')", async () => {
    const callOrder: string[] = [];
    const issue = makeIssue();
    const service = makeService({
      listIssuesByState: vi.fn().mockResolvedValue([issue]),
      isMentionedByWorker: vi.fn().mockResolvedValue(true)
    });
    service.transitionTo = vi.fn(async () => { callOrder.push("transitionTo"); });
    const runner = makeRunner();
    runner.runIssue = vi.fn(async () => { callOrder.push("runIssue"); return { runner: "local-docker" as const }; });
    await runOrchestration(service, runner, makeConfig({ STEP_IMPLEMENTATION: true }), "o/r");
    expect(callOrder).toEqual(["runIssue", "transitionTo"]);
  });

  it("limits accepted issues to MAX_ACCEPT_PER_RUN", async () => {
    const issue1 = makeIssue({ number: 1 });
    const issue2 = makeIssue({ number: 2 });
    const service = makeService({
      listIssuesByState: vi.fn().mockResolvedValue([issue1, issue2]),
      isMentionedByWorker: vi.fn().mockResolvedValue(true)
    });
    const runner = makeRunner();
    await runOrchestration(service, runner, makeConfig({ MAX_ACCEPT_PER_RUN: 1 }), "owner/repo");
    expect(runner.runIssue).toHaveBeenCalledOnce();
    expect(service.transitionTo).toHaveBeenCalledOnce();
  });
});

describe("runOrchestration – STEP_PR_MERGE", () => {
  it("merges PR and closes issue for a pr_reviewed issue", async () => {
    const issue = makeIssue({ state: "pr_reviewed", labels: ["pr-reviewed"] });
    const pr = { number: 10, url: "https://github.com/owner/repo/pull/10", branch: "fix/thing", baseBranch: "main" };
    const service = makeService({
      listIssuesByState: vi.fn().mockImplementation((state) =>
        state === "pr_reviewed" ? Promise.resolve([issue]) : Promise.resolve([])
      ),
      findLinkedPr: vi.fn().mockResolvedValue(pr)
    });
    const runner = makeRunner();
    await runOrchestration(service, runner, makeConfig({ STEP_PR_MERGE: true, STEP_IMPLEMENTATION: false }), "owner/repo");
    expect(service.mergePr).toHaveBeenCalledWith(pr);
    expect(service.transitionTo).toHaveBeenCalledWith(issue, "closed", { closeReason: "completed" });
  });

  it("skips issues where prReviewOutcome is human_needed", async () => {
    const issue = makeIssue({ state: "pr_reviewed", labels: ["pr-reviewed", "human-needed"], prReviewOutcome: "human_needed" });
    const service = makeService({
      listIssuesByState: vi.fn().mockImplementation((state) =>
        state === "pr_reviewed" ? Promise.resolve([issue]) : Promise.resolve([])
      )
    });
    const runner = makeRunner();
    await runOrchestration(service, runner, makeConfig({ STEP_PR_MERGE: true, STEP_IMPLEMENTATION: false }), "owner/repo");
    expect(service.mergePr).not.toHaveBeenCalled();
    expect(service.transitionTo).not.toHaveBeenCalled();
  });

  it("skips merge when no linked PR is found", async () => {
    const issue = makeIssue({ state: "pr_reviewed", labels: ["pr-reviewed"] });
    const service = makeService({
      listIssuesByState: vi.fn().mockImplementation((state) =>
        state === "pr_reviewed" ? Promise.resolve([issue]) : Promise.resolve([])
      ),
      findLinkedPr: vi.fn().mockResolvedValue(null)
    });
    const runner = makeRunner();
    await runOrchestration(service, runner, makeConfig({ STEP_PR_MERGE: true, STEP_IMPLEMENTATION: false }), "owner/repo");
    expect(service.mergePr).not.toHaveBeenCalled();
    expect(service.transitionTo).not.toHaveBeenCalled();
  });
});

describe("runOrchestration – STEP_PR_REVIEW", () => {
  const prReviewConfig = makeConfig({ STEP_PR_REVIEW: true, STEP_IMPLEMENTATION: false });
  const pr = { number: 42, url: "https://github.com/owner/repo/pull/42", branch: "feat/x", baseBranch: "main" };

  it("calls listIssuesByState('pr_created') when STEP_PR_REVIEW=true", async () => {
    const service = makeService();
    const runner = makeRunner();
    await runOrchestration(service, runner, prReviewConfig, "owner/repo");
    expect(service.listIssuesByState).toHaveBeenCalledWith("pr_created");
  });

  it("dispatches PR review: calls markPrReviewDispatched then runPrReview", async () => {
    const issue = makeIssue({ state: "pr_created", labels: ["pr-created"] });
    const service = makeService({
      listIssuesByState: vi.fn().mockImplementation((state) =>
        state === "pr_created" ? Promise.resolve([issue]) : Promise.resolve([])
      ),
      isPrReviewDispatched: vi.fn().mockResolvedValue(false),
      findLinkedPr: vi.fn().mockResolvedValue(pr)
    });
    const markOrder: string[] = [];
    service.markPrReviewDispatched = vi.fn().mockImplementation(() => { markOrder.push("mark"); return Promise.resolve(); });
    const runner = makeRunner();
    (runner.runPrReview as ReturnType<typeof vi.fn>).mockImplementation(() => { markOrder.push("run"); return Promise.resolve({ runner: "local-docker" }); });

    await runOrchestration(service, runner, prReviewConfig, "owner/repo");

    expect(service.markPrReviewDispatched).toHaveBeenCalledWith(issue);
    expect(runner.runPrReview).toHaveBeenCalledOnce();
    // mark must happen before run so a crash in runPrReview doesn't cause a re-dispatch loop
    expect(markOrder).toEqual(["mark", "run"]);
  });

  it("skips issue when isPrReviewDispatched returns true", async () => {
    const issue = makeIssue({ state: "pr_created", labels: ["pr-created", "pr-review-dispatched"] });
    const service = makeService({
      listIssuesByState: vi.fn().mockImplementation((state) =>
        state === "pr_created" ? Promise.resolve([issue]) : Promise.resolve([])
      ),
      isPrReviewDispatched: vi.fn().mockResolvedValue(true)
    });
    const runner = makeRunner();
    await runOrchestration(service, runner, prReviewConfig, "owner/repo");
    expect(runner.runPrReview).not.toHaveBeenCalled();
    expect(service.markPrReviewDispatched).not.toHaveBeenCalled();
  });

  it("skips dispatch when no linked PR is found", async () => {
    const issue = makeIssue({ state: "pr_created", labels: ["pr-created"] });
    const service = makeService({
      listIssuesByState: vi.fn().mockImplementation((state) =>
        state === "pr_created" ? Promise.resolve([issue]) : Promise.resolve([])
      ),
      isPrReviewDispatched: vi.fn().mockResolvedValue(false),
      findLinkedPr: vi.fn().mockResolvedValue(null)
    });
    const runner = makeRunner();
    await runOrchestration(service, runner, prReviewConfig, "owner/repo");
    expect(runner.runPrReview).not.toHaveBeenCalled();
    expect(service.markPrReviewDispatched).not.toHaveBeenCalled();
  });

  it("does NOT dispatch in DRY_RUN mode", async () => {
    const issue = makeIssue({ state: "pr_created", labels: ["pr-created"] });
    const service = makeService({
      listIssuesByState: vi.fn().mockImplementation((state) =>
        state === "pr_created" ? Promise.resolve([issue]) : Promise.resolve([])
      ),
      isPrReviewDispatched: vi.fn().mockResolvedValue(false),
      findLinkedPr: vi.fn().mockResolvedValue(pr)
    });
    const runner = makeRunner();
    await runOrchestration(service, runner, makeConfig({ STEP_PR_REVIEW: true, STEP_IMPLEMENTATION: false, DRY_RUN: true }), "owner/repo");
    expect(runner.runPrReview).not.toHaveBeenCalled();
    expect(service.markPrReviewDispatched).not.toHaveBeenCalled();
  });

  it("continues processing remaining issues after a per-issue error", async () => {
    const issue1 = makeIssue({ number: 1, state: "pr_created", labels: ["pr-created"] });
    const issue2 = makeIssue({ number: 2, state: "pr_created", labels: ["pr-created"] });
    const service = makeService({
      listIssuesByState: vi.fn().mockImplementation((state) =>
        state === "pr_created" ? Promise.resolve([issue1, issue2]) : Promise.resolve([])
      ),
      isPrReviewDispatched: vi.fn().mockResolvedValue(false),
      findLinkedPr: vi.fn()
        .mockResolvedValueOnce(pr)
        .mockResolvedValueOnce(pr)
    });
    service.markPrReviewDispatched = vi.fn()
      .mockRejectedValueOnce(new Error("label API down"))
      .mockResolvedValueOnce(undefined);
    const runner = makeRunner();
    await expect(
      runOrchestration(service, runner, prReviewConfig, "owner/repo")
    ).resolves.not.toThrow();
    // second issue should still be processed despite first failing
    expect(runner.runPrReview).toHaveBeenCalledOnce();
  });
});

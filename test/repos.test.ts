import { describe, expect, it } from "vitest";
import { parseRepos } from "../src/repos.js";
import type { Config } from "../src/config.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    GITHUB_TOKEN: "tok",
    JOB_RUNNER: "local-docker",
    WORKER_MENTION: "@worker",
    LABEL_IN_PROGRESS: "in-progress",
    LABEL_PR_CREATED: "pr-created",
    LABEL_PR_REVIEWED: "pr-reviewed",
    LABEL_HUMAN_NEEDED: "human-needed",
    LABEL_IN_REVIEW: "in-review",
    POLL_INTERVAL_SECONDS: 60,
    MAX_ACCEPT_PER_RUN: 5,
    DRY_RUN: false,
    STEP_PR_MERGE: false,
    STEP_PR_REVIEW: true,
    STEP_IMPLEMENTATION: true,
    PR_MERGE_METHOD: "squash",
    ACA_JOB_NAME: "issue-agent",
    LLM_MODEL: "openai/gpt-5-mini",
    WORKER_IMAGE: "worker:latest",
    CREATE_JOB_IF_MISSING: false,
    AZURE_USE_MANAGED_IDENTITY: false,
    HEALTH_HOST: "0.0.0.0",
    HEALTH_PORT: 8080,
    WORK_HOURS_START: 7,
    WORK_HOURS_END: 21,
    WORK_HOURS_TZ: "Europe/Prague",
    LABEL_FAILED: "worker-failed",
    ...overrides
  } as Config;
}

describe("parseRepos – REPOS (JSON)", () => {
  it("parses a single github entry with explicit steps", () => {
    const cfg = makeConfig({
      REPOS: JSON.stringify([
        { provider: "github", slug: "owner/repo", steps: ["impl", "review", "merge"] }
      ])
    });
    const repos = parseRepos(cfg);
    expect(repos).toEqual([
      {
        provider: "github",
        owner: "owner",
        repo: "repo",
        steps: { impl: true, review: true, merge: true }
      }
    ]);
  });

  it("defaults steps to impl+review (no merge) when omitted", () => {
    const cfg = makeConfig({
      REPOS: JSON.stringify([{ provider: "github", slug: "owner/repo" }])
    });
    expect(parseRepos(cfg)[0].steps).toEqual({ impl: true, review: true, merge: false });
  });

  it("allows enabling merge for one repo only (the requested use case)", () => {
    const cfg = makeConfig({
      REPOS: JSON.stringify([
        { provider: "github", slug: "etnetera/waulter", steps: ["impl", "review"] },
        { provider: "github", slug: "beranradek/sum", steps: ["impl", "review", "merge"] }
      ])
    });
    const repos = parseRepos(cfg);
    expect(repos[0].steps.merge).toBe(false);
    expect(repos[1].steps.merge).toBe(true);
  });

  it("treats empty steps array as 'all steps disabled'", () => {
    const cfg = makeConfig({
      REPOS: JSON.stringify([{ provider: "github", slug: "o/r", steps: [] }])
    });
    expect(parseRepos(cfg)[0].steps).toEqual({ impl: false, review: false, merge: false });
  });

  it("parses gitlab provider (parsed but skipped downstream)", () => {
    const cfg = makeConfig({
      REPOS: JSON.stringify([{ provider: "gitlab", slug: "beranradek/autoworker" }])
    });
    expect(parseRepos(cfg)[0].provider).toBe("gitlab");
  });

  it("rejects unknown provider", () => {
    const cfg = makeConfig({
      REPOS: JSON.stringify([{ provider: "bitbucket", slug: "o/r" }])
    });
    expect(() => parseRepos(cfg)).toThrow(/Invalid REPOS/);
  });

  it("rejects unknown step token", () => {
    const cfg = makeConfig({
      REPOS: JSON.stringify([{ provider: "github", slug: "o/r", steps: ["impl", "deploy"] }])
    });
    expect(() => parseRepos(cfg)).toThrow(/Invalid REPOS/);
  });

  it("rejects malformed slug", () => {
    const cfg = makeConfig({
      REPOS: JSON.stringify([{ provider: "github", slug: "no-slash" }])
    });
    expect(() => parseRepos(cfg)).toThrow(/Invalid REPOS/);
  });

  it("rejects malformed JSON", () => {
    const cfg = makeConfig({ REPOS: "{not json" });
    expect(() => parseRepos(cfg)).toThrow(/REPOS is not valid JSON/);
  });

  it("rejects empty array", () => {
    const cfg = makeConfig({ REPOS: "[]" });
    expect(() => parseRepos(cfg)).toThrow(/Invalid REPOS/);
  });
});

describe("parseRepos – GITHUB_REPOS (deprecated)", () => {
  it("falls back to GITHUB_REPOS when REPOS is unset", () => {
    const cfg = makeConfig({ GITHUB_REPOS: "owner/repo" });
    expect(parseRepos(cfg)).toEqual([
      {
        provider: "github",
        owner: "owner",
        repo: "repo",
        steps: { impl: true, review: true, merge: false }
      }
    ]);
  });

  it("derives steps from global STEP_* env vars", () => {
    const cfg = makeConfig({
      GITHUB_REPOS: "o/r",
      STEP_IMPLEMENTATION: true,
      STEP_PR_REVIEW: true,
      STEP_PR_MERGE: true
    });
    expect(parseRepos(cfg)[0].steps).toEqual({ impl: true, review: true, merge: true });
  });

  it("parses multiple comma/whitespace-separated entries", () => {
    const cfg = makeConfig({ GITHUB_REPOS: "a/b, c/d  e/f" });
    const repos = parseRepos(cfg);
    expect(repos.map((r) => `${r.owner}/${r.repo}`)).toEqual(["a/b", "c/d", "e/f"]);
    expect(repos.every((r) => r.provider === "github")).toBe(true);
  });

  it("rejects invalid GITHUB_REPOS entry", () => {
    const cfg = makeConfig({ GITHUB_REPOS: "no-slash" });
    expect(() => parseRepos(cfg)).toThrow(/Invalid GITHUB_REPOS entry/);
  });
});

describe("parseRepos – precedence", () => {
  it("uses REPOS and warns when both REPOS and GITHUB_REPOS are set", () => {
    const cfg = makeConfig({
      REPOS: JSON.stringify([{ provider: "github", slug: "from/repos" }]),
      GITHUB_REPOS: "from/legacy"
    });
    const repos = parseRepos(cfg);
    expect(repos).toHaveLength(1);
    expect(`${repos[0].owner}/${repos[0].repo}`).toBe("from/repos");
  });

  it("throws when neither REPOS nor GITHUB_REPOS is set", () => {
    const cfg = makeConfig({});
    expect(() => parseRepos(cfg)).toThrow(/No repos configured/);
  });

  it("treats whitespace-only REPOS as unset and falls through to GITHUB_REPOS", () => {
    const cfg = makeConfig({ REPOS: "   ", GITHUB_REPOS: "o/r" });
    const repos = parseRepos(cfg);
    expect(`${repos[0].owner}/${repos[0].repo}`).toBe("o/r");
  });
});

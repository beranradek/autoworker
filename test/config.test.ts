import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";

function withEnv(env: Record<string, string>, fn: () => void) {
  const prev = process.env;
  process.env = { ...prev, ...env };
  try {
    fn();
  } finally {
    process.env = prev;
  }
}

describe("getConfig", () => {
  it("does not require Azure vars for local-docker runner", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_OWNER: "o",
        GITHUB_REPO: "r",
        JOB_RUNNER: "local-docker",
        WORKER_IMAGE: "worker:latest",
        ANTHROPIC_API_KEY: "k"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.JOB_RUNNER).toBe("local-docker");
      }
    );
  });

  it("requires Azure vars for aca runner", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_OWNER: "o",
        GITHUB_REPO: "r",
        JOB_RUNNER: "aca",
        WORKER_IMAGE: "worker:latest",
        ANTHROPIC_API_KEY: "k"
      },
      () => {
        expect(() => getConfig()).toThrow(/ACA runner requires/);
      }
    );
  });
});


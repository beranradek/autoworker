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
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "local-docker",
        DRY_RUN: "true"
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
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "aca",
        DRY_RUN: "true"
      },
      () => {
        expect(() => getConfig()).toThrow(/ACA runner requires/);
      }
    );
  });

  it("accepts OPENAI_API_KEY in non-dry-run mode", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "local-docker",
        WORKER_IMAGE: "img",
        OPENAI_API_KEY: "oai-key"
      },
      () => {
        expect(getConfig().OPENAI_API_KEY).toBe("oai-key");
      }
    );
  });

  it("accepts ANTHROPIC_API_KEY in non-dry-run mode", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "local-docker",
        WORKER_IMAGE: "img",
        ANTHROPIC_API_KEY: "ant-key",
        LLM_MODEL: "anthropic/claude-opus-4-7"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.ANTHROPIC_API_KEY).toBe("ant-key");
        expect(cfg.OPENAI_API_KEY).toBeUndefined();
      }
    );
  });

  it("accepts AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT in non-dry-run mode", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "local-docker",
        WORKER_IMAGE: "img",
        AZURE_OPENAI_API_KEY: "az-key",
        AZURE_OPENAI_ENDPOINT: "https://my-resource.openai.azure.com",
        LLM_MODEL: "azure/gpt-4o-prod"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.AZURE_OPENAI_API_KEY).toBe("az-key");
        expect(cfg.AZURE_OPENAI_ENDPOINT).toBe("https://my-resource.openai.azure.com");
      }
    );
  });

  it("throws when no LLM provider key is set in non-dry-run mode", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "local-docker",
        WORKER_IMAGE: "img"
      },
      () => {
        expect(() => getConfig()).toThrow(/OPENAI_API_KEY/);
      }
    );
  });

  it("throws when AZURE_OPENAI_API_KEY is set without AZURE_OPENAI_ENDPOINT", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "local-docker",
        WORKER_IMAGE: "img",
        AZURE_OPENAI_API_KEY: "az-key"
      },
      () => {
        expect(() => getConfig()).toThrow();
      }
    );
  });
});

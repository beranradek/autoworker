import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";

function withEnv(env: Record<string, string>, fn: () => void) {
  const prev = process.env;
  const next = { ...prev };
  // Keep tests hermetic even if the shell environment provides real credentials.
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AZURE_API_KEY", "AZURE_RESOURCE_NAME", "OPENCODE_AUTH_JSON"]) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (next as Record<string, string | undefined>)[k];
  }
  process.env = { ...next, ...env };
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

  it("accepts AZURE_API_KEY + AZURE_RESOURCE_NAME in non-dry-run mode", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "local-docker",
        WORKER_IMAGE: "img",
        AZURE_API_KEY: "az-key",
        AZURE_RESOURCE_NAME: "my-resource",
        LLM_MODEL: "azure/gpt-4o-prod"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.AZURE_API_KEY).toBe("az-key");
        expect(cfg.AZURE_RESOURCE_NAME).toBe("my-resource");
      }
    );
  });

  it("accepts OPENCODE_AUTH_JSON (subscription auth) in non-dry-run mode", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "local-docker",
        WORKER_IMAGE: "img",
        OPENCODE_AUTH_JSON: '{"anthropic":{"type":"oauth"}}',
        LLM_MODEL: "anthropic/claude-opus-4-7"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.OPENCODE_AUTH_JSON).toBe('{"anthropic":{"type":"oauth"}}');
        expect(cfg.OPENAI_API_KEY).toBeUndefined();
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

  it("throws when AZURE_API_KEY is set without AZURE_RESOURCE_NAME", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "local-docker",
        WORKER_IMAGE: "img",
        AZURE_API_KEY: "az-key"
      },
      () => {
        expect(() => getConfig()).toThrow(/AZURE_RESOURCE_NAME/);
      }
    );
  });

  it("STEP_PR_MERGE defaults to false", () => {
    withEnv(
      { GITHUB_TOKEN: "x", GITHUB_REPOS: "o/r", JOB_RUNNER: "local-docker", DRY_RUN: "true" },
      () => {
        expect(getConfig().STEP_PR_MERGE).toBe(false);
      }
    );
  });

  it("STEP_PR_REVIEW defaults to true", () => {
    withEnv(
      { GITHUB_TOKEN: "x", GITHUB_REPOS: "o/r", JOB_RUNNER: "local-docker", DRY_RUN: "true" },
      () => {
        expect(getConfig().STEP_PR_REVIEW).toBe(true);
      }
    );
  });

  it("STEP_IMPLEMENTATION defaults to true", () => {
    withEnv(
      { GITHUB_TOKEN: "x", GITHUB_REPOS: "o/r", JOB_RUNNER: "local-docker", DRY_RUN: "true" },
      () => {
        expect(getConfig().STEP_IMPLEMENTATION).toBe(true);
      }
    );
  });

  it("parses STEP_PR_MERGE=true from env string", () => {
    withEnv(
      { GITHUB_TOKEN: "x", GITHUB_REPOS: "o/r", JOB_RUNNER: "local-docker", DRY_RUN: "true", STEP_PR_MERGE: "true" },
      () => {
        expect(getConfig().STEP_PR_MERGE).toBe(true);
      }
    );
  });

  it("has correct default label values for new orchestration labels", () => {
    withEnv(
      { GITHUB_TOKEN: "x", GITHUB_REPOS: "o/r", JOB_RUNNER: "local-docker", DRY_RUN: "true" },
      () => {
        const cfg = getConfig();
        expect(cfg.LABEL_PR_CREATED).toBe("pr-created");
        expect(cfg.LABEL_PR_REVIEWED).toBe("pr-reviewed");
        expect(cfg.LABEL_IN_REVIEW).toBe("in-review");
        expect(cfg.LABEL_HUMAN_NEEDED).toBe("human-needed");
      }
    );
  });

  it("PR_MERGE_METHOD defaults to squash", () => {
    withEnv(
      { GITHUB_TOKEN: "x", GITHUB_REPOS: "o/r", JOB_RUNNER: "local-docker", DRY_RUN: "true" },
      () => {
        expect(getConfig().PR_MERGE_METHOD).toBe("squash");
      }
    );
  });

  it("rejects invalid PR_MERGE_METHOD value", () => {
    withEnv(
      { GITHUB_TOKEN: "x", GITHUB_REPOS: "o/r", JOB_RUNNER: "local-docker", DRY_RUN: "true", PR_MERGE_METHOD: "fast-forward" },
      () => {
        expect(() => getConfig()).toThrow();
      }
    );
  });

  it("throws when WORKER_IMAGE is absent even if PR_REVIEW_WORKER_IMAGE is set", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "local-docker",
        PR_REVIEW_WORKER_IMAGE: "review-img",
        OPENAI_API_KEY: "oai-key"
      },
      () => {
        expect(() => getConfig()).toThrow(/Worker config missing/);
      }
    );
  });

  it("accepts REPOS instead of GITHUB_REPOS", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        REPOS: '[{"provider":"github","slug":"o/r"}]',
        JOB_RUNNER: "local-docker",
        DRY_RUN: "true"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.REPOS).toBe('[{"provider":"github","slug":"o/r"}]');
        expect(cfg.GITHUB_REPOS).toBeUndefined();
      }
    );
  });

  it("throws when neither REPOS nor GITHUB_REPOS is set", () => {
    withEnv(
      { GITHUB_TOKEN: "x", JOB_RUNNER: "local-docker", DRY_RUN: "true" },
      () => {
        expect(() => getConfig()).toThrow(/Missing repo configuration/);
      }
    );
  });

  it("rejects malformed REPOS JSON at startup", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        REPOS: "{not json",
        JOB_RUNNER: "local-docker",
        DRY_RUN: "true"
      },
      () => {
        expect(() => getConfig()).toThrow(/REPOS is not valid JSON/);
      }
    );
  });

  it("rejects structurally-invalid REPOS at startup (unknown provider)", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        REPOS: '[{"provider":"bitbucket","slug":"o/r"}]',
        JOB_RUNNER: "local-docker",
        DRY_RUN: "true"
      },
      () => {
        expect(() => getConfig()).toThrow(/Invalid REPOS/);
      }
    );
  });

  it("accepts configuration where PR_REVIEW_WORKER_IMAGE overrides WORKER_IMAGE when both are present", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        JOB_RUNNER: "local-docker",
        WORKER_IMAGE: "base-img",
        PR_REVIEW_WORKER_IMAGE: "review-img",
        OPENAI_API_KEY: "oai-key"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.WORKER_IMAGE).toBe("base-img");
        expect(cfg.PR_REVIEW_WORKER_IMAGE).toBe("review-img");
      }
    );
  });

  it("accepts API_KEY in config", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        DRY_RUN: "true",
        API_KEY: "my-secret-api-key"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.API_KEY).toBe("my-secret-api-key");
      }
    );
  });

  it("accepts ORCHESTRATOR_INTERNAL_URL in config", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        DRY_RUN: "true",
        API_KEY: "key",
        ORCHESTRATOR_INTERNAL_URL: "http://host.docker.internal:8080"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.ORCHESTRATOR_INTERNAL_URL).toBe("http://host.docker.internal:8080");
      }
    );
  });

  it("ORCHESTRATOR_INTERNAL_URL defaults to undefined when not set", () => {
    withEnv(
      {
        GITHUB_TOKEN: "x",
        GITHUB_REPOS: "o/r",
        DRY_RUN: "true",
        API_KEY: "key"
      },
      () => {
        const cfg = getConfig();
        expect(cfg.ORCHESTRATOR_INTERNAL_URL).toBeUndefined();
      }
    );
  });
});

import { z } from "zod";
import { log } from "./log.js";
import type { Config } from "./config.js";

export type Provider = "github" | "gitlab";

export type RepoSteps = {
  impl: boolean;
  review: boolean;
  merge: boolean;
};

export type RepoConfig = {
  provider: Provider;
  owner: string;
  repo: string;
  steps: RepoSteps;
};

const STEP_TOKEN = z.enum(["impl", "review", "merge"]);

const REPO_ENTRY = z.object({
  provider: z.enum(["github", "gitlab"]),
  slug: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "slug must be 'owner/repo'"),
  steps: z.array(STEP_TOKEN).optional()
});

const REPOS_SCHEMA = z.array(REPO_ENTRY).min(1);

// When `steps` is omitted on a REPOS entry, this is what each repo gets.
// Auto-merge must be opted in per repo.
const DEFAULT_STEPS: RepoSteps = { impl: true, review: true, merge: false };

function toSteps(tokens: ReadonlyArray<z.infer<typeof STEP_TOKEN>> | undefined): RepoSteps {
  if (!tokens) return { ...DEFAULT_STEPS };
  return {
    impl: tokens.includes("impl"),
    review: tokens.includes("review"),
    merge: tokens.includes("merge")
  };
}

function splitSlug(slug: string): { owner: string; repo: string } {
  const [owner, repo] = slug.split("/", 2);
  return { owner, repo };
}

/**
 * Parse repo configuration from either the new `REPOS` JSON env var (preferred)
 * or the legacy `GITHUB_REPOS` + global `STEP_*` env vars (deprecated).
 *
 * When both are set, `REPOS` wins and a deprecation warning is logged.
 */
export function parseRepos(cfg: Config): RepoConfig[] {
  if (cfg.REPOS && cfg.REPOS.trim()) {
    if (cfg.GITHUB_REPOS) {
      log("warn", "repos.both_set", {
        note: "REPOS and GITHUB_REPOS are both set; REPOS wins. GITHUB_REPOS is deprecated."
      });
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(cfg.REPOS);
    } catch (err) {
      throw new Error(`REPOS is not valid JSON: ${String(err)}`);
    }
    const result = REPOS_SCHEMA.safeParse(parsedJson);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid REPOS configuration: ${issues}`);
    }
    return result.data.map((entry) => {
      const { owner, repo } = splitSlug(entry.slug);
      return {
        provider: entry.provider,
        owner,
        repo,
        steps: toSteps(entry.steps)
      };
    });
  }

  if (cfg.GITHUB_REPOS && cfg.GITHUB_REPOS.trim()) {
    log("warn", "repos.deprecated_github_repos", {
      note: "GITHUB_REPOS + STEP_* env vars are deprecated; migrate to REPOS (JSON). See README."
    });
    const legacySteps: RepoSteps = {
      impl: cfg.STEP_IMPLEMENTATION,
      review: cfg.STEP_PR_REVIEW,
      merge: cfg.STEP_PR_MERGE
    };
    return cfg.GITHUB_REPOS.split(/[\s,]+/g)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((full) => {
        const [owner, repo] = full.split("/", 2);
        if (!owner || !repo) {
          throw new Error(`Invalid GITHUB_REPOS entry (expected owner/repo): ${full}`);
        }
        return {
          provider: "github" as const,
          owner,
          repo,
          steps: { ...legacySteps }
        };
      });
  }

  throw new Error("No repos configured: set REPOS (JSON) or GITHUB_REPOS (deprecated)");
}

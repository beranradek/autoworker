#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { log, die } from "./lib/common.mjs";
import { runImplementation } from "./lib/implement.mjs";
import { runPrReview } from "./lib/review.mjs";

async function main() {
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
  const AZURE_API_KEY = process.env.AZURE_API_KEY || "";
  const AZURE_RESOURCE_NAME = process.env.AZURE_RESOURCE_NAME || "";
  const OPENCODE_AUTH_JSON = process.env.OPENCODE_AUTH_JSON || "";
  const LLM_MODEL = process.env.LLM_MODEL || "openai/gpt-5-mini";

  if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY && !AZURE_API_KEY && !OPENCODE_AUTH_JSON) {
    die("One of OPENCODE_AUTH_JSON (subscription auth), OPENAI_API_KEY, ANTHROPIC_API_KEY, or AZURE_API_KEY is required");
  }
  if (AZURE_API_KEY && !AZURE_RESOURCE_NAME) {
    die("AZURE_RESOURCE_NAME is required when AZURE_API_KEY is set");
  }

  const WORKER_MODE = process.env.WORKER_MODE || "implementation";

  const WORKDIR = process.env.WORKDIR || "/workspace";
  const CLONE_DIR = process.env.CLONE_DIR || path.join(WORKDIR, "repo");
  const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(WORKDIR, "artifacts");

  const ISSUE_URL = process.env.ISSUE_URL || "";
  const ISSUE_REPO = process.env.ISSUE_REPO || process.env.GITHUB_REPOSITORY || "";
  const ISSUE_NUMBER = process.env.ISSUE_NUMBER || "";
  const ISSUE_TEXT = process.env.ISSUE_TEXT || "";
  const ISSUE_FILE = process.env.ISSUE_FILE || "";

  fs.mkdirSync(WORKDIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  let issueText = ISSUE_TEXT;
  if (ISSUE_FILE) {
    if (!fs.existsSync(ISSUE_FILE)) die(`ISSUE_FILE not found: ${ISSUE_FILE}`);
    issueText = fs.readFileSync(ISSUE_FILE, "utf8");
  }

  let ownerRepo = "";
  let issueNum = "";
  if (ISSUE_URL) {
    const m = ISSUE_URL.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/([0-9]+)/);
    if (!m) die(`Unsupported ISSUE_URL format: ${ISSUE_URL}`);
    ownerRepo = `${m[1]}/${m[2]}`;
    issueNum = m[3];
  } else if (ISSUE_REPO && ISSUE_NUMBER) {
    ownerRepo = ISSUE_REPO;
    issueNum = ISSUE_NUMBER;
  } else if (issueText) {
    ownerRepo = ISSUE_REPO;
  } else {
    die("Provide one of: ISSUE_URL, (ISSUE_REPO + ISSUE_NUMBER), ISSUE_TEXT, or ISSUE_FILE");
  }

  if (ownerRepo && !GH_TOKEN) {
    die(`GH_TOKEN (or GITHUB_TOKEN) is required for repo operations: ${ownerRepo}`);
  }

  const ghEnv = { ...process.env, GH_TOKEN, GITHUB_TOKEN: GH_TOKEN };
  log("info", "harness.start", {
    ownerRepo: ownerRepo || null,
    issueNum: issueNum || null,
    issueUrl: ISSUE_URL || null,
    cloneDir: CLONE_DIR,
    artifactsDir: ARTIFACTS_DIR,
    llmModel: LLM_MODEL,
    workerMode: WORKER_MODE,
    verifyCmdConfigured: Boolean(process.env.VERIFY_CMD)
  });

  if (WORKER_MODE === "pr-review") {
    await runPrReview(ghEnv, CLONE_DIR, ARTIFACTS_DIR);
    return;
  }

  await runImplementation(ghEnv, CLONE_DIR, ARTIFACTS_DIR, WORKDIR, {
    GH_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, AZURE_API_KEY, AZURE_RESOURCE_NAME,
    OPENCODE_AUTH_JSON, LLM_MODEL, ownerRepo, issueNum, issueUrl: ISSUE_URL, issueText, ISSUE_REPO
  });
}

main().catch((e) => { die("Unhandled error", { error: String(e?.stack || e) }); });

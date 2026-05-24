#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function log(level, msg, extra) {
  const record = { ts: nowIso(), level, msg, ...(extra ?? {}) };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function die(message, extra) {
  log("error", "fatal", { message, ...(extra ?? {}) });
  process.exit(2);
}

function redact(str) {
  if (!str) return str;
  return str
    .replaceAll(/\b(ghp_[A-Za-z0-9]{20,})\b/g, "***")
    .replaceAll(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, "***")
    .replaceAll(/\b(sk-[A-Za-z0-9]{20,})\b/g, "***");
}

function sanitizeBranchPart(input) {
  return String(input)
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 40);
}

function cleanSingleLine(input, maxLen) {
  const s = String(input ?? "").replaceAll(/\r?\n/g, " ").replaceAll(/\s+/g, " ").trim();
  if (!s) return "";
  return s.slice(0, maxLen);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, reason: "missing" };
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, reason: "invalid_json", error: String(e) };
  }
}

async function run(cmd, args, opts) {
  const printable = [cmd, ...(args ?? [])].map((s) => (typeof s === "string" ? s : String(s)));
  log("info", "exec.start", { cmd: printable[0], args: printable.slice(1).map(redact) });

  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b) => {
      const s = String(b);
      stdout += s;
      process.stderr.write(s);
    });
    child.stderr?.on("data", (b) => {
      const s = String(b);
      stderr += s;
      process.stderr.write(s);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      log(exitCode === 0 ? "info" : "warn", "exec.done", { cmd: printable[0], exitCode });
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function main() {
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
  const LLM_MODEL = process.env.LLM_MODEL || "openai/gpt-5-mini";

  if (!OPENAI_API_KEY) die("OPENAI_API_KEY is required");

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
    verifyCmdConfigured: Boolean(process.env.VERIFY_CMD)
  });

  if (ownerRepo) {
    // Fresh clone every run to avoid cross-run state.
    await run("bash", ["-lc", `rm -rf "${CLONE_DIR}" && mkdir -p "${path.dirname(CLONE_DIR)}"`], { env: process.env });
    const cloneRes = await run("gh", ["repo", "clone", ownerRepo, CLONE_DIR], { env: ghEnv });
    if (cloneRes.exitCode !== 0) die("Failed to clone repo (gh repo clone)", { exitCode: cloneRes.exitCode });
  }

  const repoDir = fs.existsSync(path.join(CLONE_DIR, ".git")) ? CLONE_DIR : WORKDIR;
  const gitEnv = { ...process.env };

  // Basic git identity for commits
  await run("git", ["config", "user.email", process.env.GIT_USER_EMAIL || "autoworker@users.noreply.github.com"], { cwd: repoDir, env: gitEnv });
  await run("git", ["config", "user.name", process.env.GIT_USER_NAME || "autoworker"], { cwd: repoDir, env: gitEnv });

  let issueTitle = "";
  let issueBody = "";
  let issueUrl = ISSUE_URL;
  if (ownerRepo && issueNum) {
    const issueJsonRes = await run("gh", ["issue", "view", issueNum, "--repo", ownerRepo, "--json", "title,body,url,number"], { env: ghEnv });
    if (issueJsonRes.exitCode !== 0) die("Failed to fetch issue metadata (gh issue view)", { exitCode: issueJsonRes.exitCode });
    try {
      const parsed = JSON.parse(issueJsonRes.stdout);
      issueTitle = String(parsed.title ?? "");
      issueBody = String(parsed.body ?? "");
      issueUrl = String(parsed.url ?? issueUrl);
    } catch (e) {
      die("Failed to parse gh issue view JSON", { error: String(e) });
    }
  }
  if (issueText && !issueBody) issueBody = issueText;

  const branchSlug = sanitizeBranchPart(issueTitle || "issue");
  const branchName = `issue-${issueNum || "manual"}-${branchSlug || "work"}`;

  // Create or reset the work branch deterministically.
  const checkoutRes = await run("git", ["checkout", "-B", branchName], { cwd: repoDir, env: gitEnv });
  if (checkoutRes.exitCode !== 0) die("Failed to create/reset branch", { branchName, exitCode: checkoutRes.exitCode });

  // Prepare prompt for OpenCode. IMPORTANT: do not give it GitHub token env vars.
  const promptPath = path.join(ARTIFACTS_DIR, "issue-prompt.txt");
  const resultJsonPath = path.join(repoDir, ".autoworker", "result.json");
  const prompt = [
    "You are an AI coding agent running inside an ephemeral Docker container with a checked-out repository.",
    "",
    "Task: resolve the GitHub issue below. Make the smallest correct change that fixes it.",
    "",
    "Hard constraints:",
    "- Do NOT run any git push, gh pr create, or gh issue comment commands.",
    "- Do NOT modify git remotes or auth configuration.",
    "- Do NOT attempt to access GitHub credentials (none are provided to you).",
    "",
    "At the end, write a JSON file at .autoworker/result.json with this schema:",
    "{",
    '  \"status\": \"success\" | \"failed\" | \"rejected\",',
    '  \"description\": string,',
    '  \"suggestedCommitMessage\"?: string,',
    '  \"suggestedPrTitle\"?: string,',
    '  \"rejectReason\"?: \"wontfix\" | \"invalid\" | \"duplicate\" | \"help_wanted\" | \"question\",',
    '  \"failureReason\"?: string',
    "}",
    "Only use rejectReason when status is rejected; only use failureReason when status is failed.",
    "",
    "Optional: run only very fast, low-risk checks. Skip anything that needs extra services.",
    "",
    "Issue:",
    `repo: ${ownerRepo || "<not-provided>"}`,
    `url: ${issueUrl || "<not-provided>"}`,
    `title: ${issueTitle || "<not-provided>"}`,
    "",
    "body:",
    issueBody || "<empty>",
    ""
  ].join("\n");
  fs.writeFileSync(promptPath, prompt, "utf8");

  const opencodeLogPath = path.join(ARTIFACTS_DIR, "opencode.log");
  const opencodeEnv = { ...process.env };
  delete opencodeEnv.GH_TOKEN;
  delete opencodeEnv.GITHUB_TOKEN;

  log("info", "opencode.start", { model: LLM_MODEL, dir: repoDir, promptPath });
  const ocChild = spawn(
    "opencode",
    ["run", "--format", "json", "--model", LLM_MODEL, "--dangerously-skip-permissions", "--dir", repoDir, fs.readFileSync(promptPath, "utf8")],
    { env: opencodeEnv, stdio: ["ignore", "pipe", "pipe"] }
  );

  const ocLogStream = fs.createWriteStream(opencodeLogPath, { flags: "a" });
  ocChild.stdout?.on("data", (b) => {
    const s = String(b);
    ocLogStream.write(s);
    process.stderr.write(s);
  });
  ocChild.stderr?.on("data", (b) => {
    const s = String(b);
    ocLogStream.write(s);
    process.stderr.write(s);
  });

  const ocExitCode = await new Promise((resolve, reject) => {
    ocChild.on("error", reject);
    ocChild.on("close", (code) => resolve(code ?? 0));
  });
  ocLogStream.end();
  log(ocExitCode === 0 ? "info" : "warn", "opencode.done", { exitCode: ocExitCode, opencodeLogPath });
  if (ocExitCode !== 0) {
    die("OpenCode (opencode) exited non-zero", { exitCode: ocExitCode });
  }

  // Optional structured result produced by the agent.
  const resultFile = readJsonFile(resultJsonPath);
  if (resultFile.ok) {
    fs.writeFileSync(path.join(ARTIFACTS_DIR, "agent-result.json"), JSON.stringify(resultFile.parsed, null, 2), "utf8");
    log("info", "agent.result.found", { path: resultJsonPath });
  } else {
    log("warn", "agent.result.missing_or_invalid", { path: resultJsonPath, reason: resultFile.reason, error: resultFile.error });
  }

  // Never commit agent metadata.
  try {
    fs.rmSync(path.join(repoDir, ".autoworker"), { recursive: true, force: true });
  } catch {
    // ignore
  }

  const statusRes = await run("git", ["status", "--porcelain"], { cwd: repoDir, env: gitEnv });
  if (statusRes.exitCode !== 0) die("git status failed", { exitCode: statusRes.exitCode });
  const changes = statusRes.stdout.trim().split("\n").filter(Boolean);
  fs.writeFileSync(path.join(ARTIFACTS_DIR, "git-status-porcelain.txt"), statusRes.stdout, "utf8");

  const diffStatRes = await run("git", ["diff", "--stat"], { cwd: repoDir, env: gitEnv });
  fs.writeFileSync(path.join(ARTIFACTS_DIR, "git-diff-stat.txt"), diffStatRes.stdout, "utf8");

  if (changes.length === 0) {
    log("info", "git.no_changes", { branchName });
    if (ownerRepo && issueNum) {
      if (resultFile.ok && String(resultFile.parsed?.status ?? "") === "rejected") {
        const rejectReason = String(resultFile.parsed?.rejectReason ?? "");
        const description = cleanSingleLine(resultFile.parsed?.description ?? "", 800);
        const reasonToLabel = {
          wontfix: process.env.REJECT_LABEL_WONTFIX || "wontfix",
          invalid: process.env.REJECT_LABEL_INVALID || "invalid",
          duplicate: process.env.REJECT_LABEL_DUPLICATE || "duplicate",
          help_wanted: process.env.REJECT_LABEL_HELP_WANTED || "help wanted",
          question: process.env.REJECT_LABEL_QUESTION || "question"
        };
        const label = reasonToLabel[rejectReason] || "";
        const acceptedLabel = process.env.ISSUE_LABEL_ACCEPTED || "accepted";
        const editArgs = ["issue", "edit", issueNum, "--repo", ownerRepo, "--remove-label", acceptedLabel];
        if (label) editArgs.push("--add-label", label);
        await run("gh", editArgs, { env: ghEnv });
        const body = [`Rejected by worker.`, rejectReason ? `Reason: ${rejectReason}` : "", description ? `Details: ${description}` : ""]
          .filter(Boolean)
          .join("\n");
        await run("gh", ["issue", "comment", issueNum, "--repo", ownerRepo, "--body", body], { env: ghEnv });
        return;
      }
      await run(
        "gh",
        ["issue", "comment", issueNum, "--repo", ownerRepo, "--body", `Worker finished but produced no git changes.`],
        { env: ghEnv }
      );
    }
    return;
  }

  // Apply agent decision if present (e.g. reject without PR).
  if (resultFile.ok) {
    const r = resultFile.parsed ?? {};
    const status = String(r.status ?? "");
    const description = cleanSingleLine(r.description ?? "", 800);
    const rejectReason = String(r.rejectReason ?? "");
    const failureReason = cleanSingleLine(r.failureReason ?? "", 400);

    if (status === "rejected") {
      const reasonToLabel = {
        wontfix: process.env.REJECT_LABEL_WONTFIX || "wontfix",
        invalid: process.env.REJECT_LABEL_INVALID || "invalid",
        duplicate: process.env.REJECT_LABEL_DUPLICATE || "duplicate",
        help_wanted: process.env.REJECT_LABEL_HELP_WANTED || "help wanted",
        question: process.env.REJECT_LABEL_QUESTION || "question"
      };
      const label = reasonToLabel[rejectReason] || "";
      log("info", "agent.result.rejected", { rejectReason, label });
      if (ownerRepo && issueNum) {
        const acceptedLabel = process.env.ISSUE_LABEL_ACCEPTED || "accepted";
        const editArgs = ["issue", "edit", issueNum, "--repo", ownerRepo, "--remove-label", acceptedLabel];
        if (label) editArgs.push("--add-label", label);
        await run("gh", editArgs, { env: ghEnv });
        const body = [`Rejected by worker.`, rejectReason ? `Reason: ${rejectReason}` : "", description ? `Details: ${description}` : ""]
          .filter(Boolean)
          .join("\n");
        await run("gh", ["issue", "comment", issueNum, "--repo", ownerRepo, "--body", body], { env: ghEnv });
      }
      return;
    }

    if (status === "failed") {
      log("warn", "agent.result.failed", { failureReason });
      if (ownerRepo && issueNum) {
        const body = [
          `Worker attempted changes but reported failure.`,
          failureReason ? `Reason: ${failureReason}` : "",
          description ? `Details: ${description}` : ""
        ]
          .filter(Boolean)
          .join("\n");
        await run("gh", ["issue", "comment", issueNum, "--repo", ownerRepo, "--body", body], { env: ghEnv });
      }
      // Continue with deterministic PR creation only if we actually have changes;
      // this comment is informational and does not prevent opening a PR.
    }
  }

  const verifyCmd = process.env.VERIFY_CMD || "";
  if (verifyCmd) {
    log("info", "verify.start", { verifyCmd });
    const verifyRes = await run("bash", ["-lc", verifyCmd], { cwd: repoDir, env: process.env });
    fs.writeFileSync(path.join(ARTIFACTS_DIR, "verify-exit-code.txt"), String(verifyRes.exitCode), "utf8");
    if (verifyRes.exitCode !== 0) die("VERIFY_CMD failed", { exitCode: verifyRes.exitCode });
    log("info", "verify.done", { exitCode: verifyRes.exitCode });
  }

  // Commit deterministically.
  let commitMsg = "";
  if (resultFile.ok && resultFile.parsed?.status === "success") {
    commitMsg = cleanSingleLine(resultFile.parsed?.suggestedCommitMessage ?? "", 120);
  }
  if (!commitMsg) {
    const commitTitle = issueTitle ? issueTitle.replaceAll(/\s+/g, " ").trim().slice(0, 60) : "worker changes";
    commitMsg = `fix: #${issueNum || "manual"} ${commitTitle}`;
  }

  const addRes = await run("git", ["add", "-A"], { cwd: repoDir, env: gitEnv });
  if (addRes.exitCode !== 0) die("git add failed", { exitCode: addRes.exitCode });

  const commitRes = await run("git", ["commit", "-m", commitMsg], { cwd: repoDir, env: gitEnv });
  if (commitRes.exitCode !== 0) die("git commit failed", { exitCode: commitRes.exitCode });

  // Ensure authenticated remote without logging the token.
  const remoteUrl = `https://x-access-token:${GH_TOKEN}@github.com/${ownerRepo}.git`;
  await run("git", ["remote", "set-url", "origin", remoteUrl], { cwd: repoDir, env: gitEnv });

  const pushRes = await run("git", ["push", "-u", "origin", branchName], { cwd: repoDir, env: gitEnv });
  if (pushRes.exitCode !== 0) die("git push failed", { exitCode: pushRes.exitCode });

  // Create PR deterministically.
  let prTitle = "";
  if (resultFile.ok && resultFile.parsed?.status === "success") {
    prTitle = cleanSingleLine(resultFile.parsed?.suggestedPrTitle ?? "", 120);
  }
  if (!prTitle) prTitle = issueTitle ? issueTitle : `Fix #${issueNum}`;
  const prBody = [
    issueNum ? `Fixes #${issueNum}` : "",
    "",
    "Automation details:",
    `- Branch: ${branchName}`,
    diffStatRes.stdout ? `- Diff stat:\n\n\`\`\`\n${diffStatRes.stdout.trim()}\n\`\`\`` : ""
  ]
    .filter(Boolean)
    .join("\n");

  log("info", "pr.create.start", { ownerRepo, branchName });
  const prCreateRes = await run("gh", ["pr", "create", "--repo", ownerRepo, "--title", prTitle, "--body", prBody, "--head", branchName], { env: ghEnv });
  if (prCreateRes.exitCode !== 0) die("gh pr create failed", { exitCode: prCreateRes.exitCode });

  const prUrlMatch = prCreateRes.stdout.match(/https:\/\/github\.com\/[^\s]+/);
  const prUrl = prUrlMatch ? prUrlMatch[0] : "";
  if (!prUrl) die("Could not parse PR URL from gh pr create output", { stdout: redact(prCreateRes.stdout) });
  fs.writeFileSync(path.join(ARTIFACTS_DIR, "pr-url.txt"), prUrl, "utf8");
  log("info", "pr.create.done", { prUrl });

  // Comment back to the issue deterministically.
  if (ownerRepo && issueNum) {
    const commentBody = `PR: ${prUrl}`;
    await run("gh", ["issue", "comment", issueNum, "--repo", ownerRepo, "--body", commentBody], { env: ghEnv });
    log("info", "issue.commented", { issueNum, prUrl });
  }

  log("info", "harness.done", { prUrl, branchName });
}

main().catch((e) => {
  die("Unhandled error", { error: String(e?.stack || e) });
});

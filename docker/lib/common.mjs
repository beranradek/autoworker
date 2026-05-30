import { emitLog } from "./events.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function nowIso() {
  return new Date().toISOString();
}

export function log(level, msg, extra) {
  const record = { ts: nowIso(), level, msg, ...(extra ?? {}) };
  process.stderr.write(`${JSON.stringify(record)}\n`);
  emitLog(level, msg, extra ?? {});
}

export function die(message, extra) {
  log("error", "fatal", { message, ...(extra ?? {}) });
  process.exit(2);
}

export function redact(str) {
  if (!str) return str;
  return str
    .replaceAll(/\b(ghp_[A-Za-z0-9]{20,})\b/g, "***")
    .replaceAll(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, "***")
    .replaceAll(/(sk-ant-[A-Za-z0-9_-]{20,})/g, "***")
    .replaceAll(/\b(sk-[A-Za-z0-9]{20,})\b/g, "***")
    .replaceAll(/\bAUTHORIZATION: basic \S+/g, "AUTHORIZATION: basic ***")
    .replaceAll(/\b(password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?key)[=:]\s*\S+/gi, "$1=***");
}

export function sanitizeUserContent(text) {
  return redact(String(text ?? ""));
}

export function sanitizeBranchPart(input) {
  return String(input)
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 40);
}

export function cleanSingleLine(input, maxLen) {
  const s = String(input ?? "").replaceAll(/\r?\n/g, " ").replaceAll(/\s+/g, " ").trim();
  if (!s) return "";
  return s.slice(0, maxLen);
}

export function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, reason: "missing" };
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, reason: "invalid_json", error: String(e) };
  }
}

export function writeOpencodeAuth(authJson, home) {
  let parsed;
  try {
    parsed = JSON.parse(authJson);
  } catch (e) {
    die("OPENCODE_AUTH_JSON is not valid JSON", { error: String(e) });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    die("OPENCODE_AUTH_JSON has no provider credentials");
  }

  for (const [provider, entry] of Object.entries(parsed)) {
    if (entry && typeof entry === "object" && entry.type === "oauth") {
      if (!entry.refresh) {
        log("warn", "opencode.auth.no_refresh", { provider, note: "cannot renew an expired access token" });
      }
      const expires = Number(entry.expires ?? 0);
      if (expires > 0) {
        const msLeft = expires - Date.now();
        if (msLeft <= 0) {
          log("warn", "opencode.auth.access_expired", { provider, expiredForMs: -msLeft, note: "OpenCode will attempt a refresh using the refresh token" });
        } else {
          log("info", "opencode.auth.access_valid", { provider, expiresInMs: msLeft });
        }
      }
    }
  }

  const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const authDir = path.join(dataHome, "opencode");
  const authPath = path.join(authDir, "auth.json");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(parsed), { mode: 0o600 });
  fs.chmodSync(authPath, 0o600);
  log("info", "opencode.auth.written", { authPath, providers: Object.keys(parsed ?? {}) });
  return dataHome;
}

export async function run(cmd, args, opts) {
  const printable = [cmd, ...(args ?? [])].map((s) => (typeof s === "string" ? s : String(s)));
  log("info", "exec.start", { cmd: printable[0], args: printable.slice(1).map(redact) });

  return await new Promise((resolve, reject) => {
    const { timeoutMs, ...spawnOpts } = opts ?? {};
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOpts
    });

    const timeoutMsNum = Number(timeoutMs ?? 0);
    const timeout =
      timeoutMsNum > 0
        ? setTimeout(() => {
            log("warn", "exec.timeout", { cmd: printable[0], timeoutMs: timeoutMsNum });
            child.kill("SIGKILL");
          }, timeoutMsNum)
        : null;

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
      if (timeout) clearTimeout(timeout);
      const exitCode = code ?? 0;
      log(exitCode === 0 ? "info" : "warn", "exec.done", { cmd: printable[0], exitCode });
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export async function runWithRetry(cmd, args, opts) {
  const retryCount = Number(process.env.CMD_RETRY_COUNT ?? "2");
  const backoffMs = Number(process.env.CMD_RETRY_BACKOFF_MS ?? "1000");
  const timeoutMs = Number(process.env.CMD_TIMEOUT_MS ?? "120000");

  let attempt = 0;
  while (true) {
    attempt += 1;
    const res = await run(cmd, args, { ...(opts ?? {}), timeoutMs });
    if (res.exitCode === 0) return res;

    if (attempt > retryCount) return res;
    log("warn", "exec.retry", { cmd, attempt, retryCount, exitCode: res.exitCode });
    await sleep(backoffMs * attempt);
  }
}

export function resolveRejectionLabel(rejectReason) {
  const reasonToLabel = {
    wontfix: process.env.REJECT_LABEL_WONTFIX || "wontfix",
    invalid: process.env.REJECT_LABEL_INVALID || "invalid",
    duplicate: process.env.REJECT_LABEL_DUPLICATE || "duplicate",
    help_wanted: process.env.REJECT_LABEL_HELP_WANTED || "help wanted",
    question: process.env.REJECT_LABEL_QUESTION || "question"
  };
  return reasonToLabel[rejectReason] || reasonToLabel.wontfix;
}

export function buildOpencodeEnv({ OPENAI_API_KEY, ANTHROPIC_API_KEY, AZURE_API_KEY, AZURE_RESOURCE_NAME, LLM_MODEL, opencodeDataHome }) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    TMPDIR: process.env.TMPDIR,
    CI: process.env.CI,
    CHROME_BIN: process.env.CHROME_BIN,
    XDG_DATA_HOME: opencodeDataHome || process.env.XDG_DATA_HOME || undefined,
    OPENAI_API_KEY: OPENAI_API_KEY || undefined,
    ANTHROPIC_API_KEY: ANTHROPIC_API_KEY || undefined,
    AZURE_API_KEY: AZURE_API_KEY || undefined,
    AZURE_RESOURCE_NAME: AZURE_RESOURCE_NAME || undefined,
    LLM_MODEL
  };
}

export function buildGitWithAuth(ghToken) {
  const authHeader = Buffer.from(`x-access-token:${ghToken}`, "utf8").toString("base64");
  return (args) => ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${authHeader}`, ...args];
}

export async function spawnOpencode({ prompt, repoDir, logPath, env, timeoutMs }) {
  const ocChild = spawn(
    "opencode",
    ["run", "--format", "json", "--model", env.LLM_MODEL, "--dangerously-skip-permissions", "--dir", repoDir, prompt],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );
  const ocLogStream = fs.createWriteStream(logPath, { flags: "a" });
  ocChild.stdout?.on("data", (b) => { const s = String(b); ocLogStream.write(s); process.stderr.write(s); });
  ocChild.stderr?.on("data", (b) => { const s = String(b); ocLogStream.write(s); process.stderr.write(s); });
  const timeout = timeoutMs > 0 ? setTimeout(() => { log("warn", "opencode.timeout", { timeoutMs }); ocChild.kill("SIGKILL"); }, timeoutMs) : null;
  const exitCode = await new Promise((resolve, reject) => {
    ocChild.on("error", reject);
    ocChild.on("close", (code) => resolve(code ?? 0));
  });
  if (timeout) clearTimeout(timeout);
  await new Promise((r) => ocLogStream.end(r));
  return exitCode;
}

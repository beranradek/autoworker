import http from "node:http";
import { getConfig } from "../config.js";
import { log } from "../log.js";
import { getStatus, markWebhookEnqueued, markWebhookError, markWebhookReceived } from "../status.js";
import { parseWebhookEvent } from "../webhook/events.js";
import { verifySignature } from "../webhook/verify.js";
import type { FifoQueue } from "../webhook/queue.js";
import type { RepoRef } from "../github/types.js";

const WEBHOOK_PATH = "/webhook";
const MAX_BODY_BYTES = 5 * 1024 * 1024; // GitHub caps payloads at ~25MB; we only need small JSON.

export type WebhookDeps = {
  secret: string;
  queue: FifoQueue;
  repos: RepoRef[];
};

function json(res: http.ServerResponse, statusCode: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

function readBody(req: http.IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleWebhook(req: http.IncomingMessage, res: http.ServerResponse, deps: WebhookDeps): Promise<void> {
  const eventType = (req.headers["x-github-event"] as string | undefined) ?? undefined;

  let body: Buffer;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    json(res, 413, { ok: false, error: "payload_too_large" });
    log("warn", "webhook.body_error", { error: String(err) });
    return;
  }

  // Verify the HMAC signature before parsing — this is the real security boundary.
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!verifySignature(deps.secret, body, signature)) {
    json(res, 401, { ok: false, error: "invalid_signature" });
    log("warn", "webhook.invalid_signature", { eventType });
    return;
  }

  markWebhookReceived(eventType ?? "unknown");

  // GitHub sends a "ping" when the webhook is first configured.
  if (eventType === "ping") {
    json(res, 200, { ok: true, pong: true });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch (err) {
    json(res, 400, { ok: false, error: "invalid_json" });
    log("warn", "webhook.invalid_json", { eventType, error: String(err) });
    return;
  }

  const parsed = parseWebhookEvent(eventType, payload);
  if (!parsed) {
    // Valid, signed, but not an event we act on (or missing repo). Ack so GitHub
    // doesn't retry.
    json(res, 202, { ok: true, queued: false, reason: "ignored_event" });
    return;
  }

  // Only act on repositories this orchestrator is configured for.
  const repo = deps.repos.find((r) => `${r.owner}/${r.repo}`.toLowerCase() === parsed.repoFullName.toLowerCase());
  if (!repo) {
    json(res, 202, { ok: true, queued: false, reason: "repo_not_configured" });
    log("warn", "webhook.repo_not_configured", { repo: parsed.repoFullName, event: parsed.summary });
    return;
  }

  const repoKey = `${repo.owner}/${repo.repo}`;
  const queued = deps.queue.enqueue({
    repo,
    repoKey,
    reason: parsed.summary,
    enqueuedAt: new Date().toISOString()
  });
  if (queued) markWebhookEnqueued(deps.queue.depth);

  log("info", "webhook.received", { repo: repoKey, event: parsed.summary, queued, queueDepth: deps.queue.depth });
  json(res, 202, { ok: true, queued });
}

export function startHealthServer(opts: { webhook?: WebhookDeps } = {}): http.Server {
  const cfg = getConfig();

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && (url === "/healthz" || url === "/readyz" || url === "/")) {
      json(res, 200, { ok: true, status: getStatus() });
      return;
    }

    if (opts.webhook && req.method === "POST" && url === WEBHOOK_PATH) {
      handleWebhook(req, res, opts.webhook).catch((err) => {
        markWebhookError(err);
        log("error", "webhook.handler_error", { error: String(err) });
        if (!res.headersSent) json(res, 500, { ok: false, error: "internal_error" });
      });
      return;
    }

    json(res, 404, { ok: false, error: "not_found" });
  });

  server.listen(cfg.HEALTH_PORT, cfg.HEALTH_HOST);
  return server;
}

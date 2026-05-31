import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { log } from "../../log.js";
import { markWebhookEnqueued, markWebhookError, markWebhookReceived } from "../../status.js";
import { parseWebhookEvent } from "../../webhook/events.js";
import { verifySignature } from "../../webhook/verify.js";
import type { FifoQueue } from "../../webhook/queue.js";
import type { RepoConfig } from "../../repos.js";

export type WebhookDeps = {
  secret: string | undefined;
  queue: FifoQueue;
  repos: RepoConfig[];
};

type WebhookPluginOpts = { deps: WebhookDeps };

export const webhookRoutes: FastifyPluginAsync<WebhookPluginOpts> = async (fastify, opts) => {
  const { deps } = opts;

  // Propagate unexpected handler errors to webhook error metrics so they remain
  // visible in the /healthz status payload (mirrors original server.ts behaviour).
  fastify.setErrorHandler((err, _req, reply) => {
    markWebhookError(err);
    log("error", "webhook.handler_error", { error: String(err) });
    if (!reply.sent) {
      reply.code(500).send({ ok: false, error: "internal_error" });
    }
  });

  // Parse body as raw Buffer so we can HMAC-verify the original bytes.
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  fastify.post<{ Body: Buffer }>("/webhook", async (req: FastifyRequest<{ Body: Buffer }>, reply: FastifyReply) => {
    const eventType = (req.headers["x-github-event"] as string | undefined) ?? "unknown";

    if (!deps.secret) {
      log("warn", "webhook.disabled", { eventType });
      return reply.code(401).send({ ok: false, error: "webhook_disabled" });
    }

    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifySignature(deps.secret, req.body, signature)) {
      log("warn", "webhook.invalid_signature", { eventType });
      return reply.code(401).send({ ok: false, error: "invalid_signature" });
    }

    markWebhookReceived(eventType);

    if (eventType === "ping") {
      return reply.code(200).send({ ok: true, pong: true });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch (err) {
      log("warn", "webhook.invalid_json", { eventType, error: String(err) });
      return reply.code(400).send({ ok: false, error: "invalid_json" });
    }

    const parsed = parseWebhookEvent(eventType, payload);
    if (!parsed) {
      return reply.code(202).send({ ok: true, queued: false, reason: "ignored_event" });
    }

    const repo = deps.repos.find(
      (r) => r.provider === "github" && `${r.owner}/${r.repo}`.toLowerCase() === parsed.repoFullName.toLowerCase()
    );
    if (!repo) {
      log("warn", "webhook.repo_not_configured", { repo: parsed.repoFullName, event: parsed.summary });
      return reply.code(202).send({ ok: true, queued: false, reason: "repo_not_configured" });
    }

    const repoKey = `${repo.owner}/${repo.repo}`;
    const queued = deps.queue.enqueue({
      repo: { owner: repo.owner, repo: repo.repo },
      repoKey,
      steps: repo.steps,
      repoToken: repo.repoToken,
      eventType: parsed.eventType,
      number: parsed.number,
      reason: parsed.summary,
      enqueuedAt: new Date().toISOString()
    });
    if (queued) markWebhookEnqueued(deps.queue.depth);

    log("info", "webhook.received", { repo: repoKey, event: parsed.summary, queued, queueDepth: deps.queue.depth });
    return reply.code(202).send({ ok: true, queued });
  });
};

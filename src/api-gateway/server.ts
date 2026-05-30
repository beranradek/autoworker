import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { getConfig } from "../config.js";
import { log } from "../log.js";
import { healthRoutes } from "./routes/health.js";
import { webhookRoutes, type WebhookDeps } from "./routes/webhook.js";
import { workersRoutes } from "./routes/workers.js";
import { internalRoutes } from "./routes/internal.js";
import type { WorkerRegistry } from "./worker-registry.js";

export type { WebhookDeps };

export type BuildAppDeps = {
  webhookDeps?: WebhookDeps;
  registry: WorkerRegistry;
  apiKey: string;
  internalSecret: string;
};

export function buildApp(deps: BuildAppDeps): FastifyInstance {
  const fastify = Fastify({ logger: false });

  fastify.register(healthRoutes);

  if (deps.webhookDeps) {
    fastify.register(webhookRoutes, { deps: deps.webhookDeps });
  }

  fastify.register(workersRoutes, { prefix: "/api", registry: deps.registry, apiKey: deps.apiKey });
  fastify.register(internalRoutes, { prefix: "/internal", registry: deps.registry, internalSecret: deps.internalSecret });

  return fastify;
}

export async function startApiServer(opts: {
  webhookDeps?: WebhookDeps;
  registry: WorkerRegistry;
  internalSecret: string;
}): Promise<FastifyInstance> {
  const cfg = getConfig();
  const apiKey = cfg.API_KEY ?? "";
  if (!apiKey) {
    log("warn", "api_server.no_api_key", { note: "API_KEY is not set — /api/* endpoints reject all requests" });
  }

  const app = buildApp({
    webhookDeps: opts.webhookDeps,
    registry: opts.registry,
    apiKey,
    internalSecret: opts.internalSecret
  });

  await app.listen({ host: cfg.HEALTH_HOST, port: cfg.HEALTH_PORT });
  log("info", "api_server.start", { host: cfg.HEALTH_HOST, port: cfg.HEALTH_PORT });
  return app;
}

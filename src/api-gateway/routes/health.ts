import type { FastifyPluginAsync } from "fastify";
import { getStatus } from "../../status.js";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  const handler = async () => ({ ok: true, status: getStatus() });
  fastify.get("/", handler);
  fastify.get("/healthz", handler);
  fastify.get("/readyz", handler);
};

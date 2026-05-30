import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { makeBearerAuth } from "../auth.js";
import type { WorkerRegistry } from "../worker-registry.js";

type InternalPluginOpts = { registry: WorkerRegistry; internalSecret: string };

type EventBody = {
  type: "lifecycle" | "log";
  ts: string;
  event?: string;
  data?: Record<string, unknown>;
  level?: string;
  fields?: Record<string, unknown>;
};

export const internalRoutes: FastifyPluginAsync<InternalPluginOpts> = async (fastify, opts) => {
  const { registry, internalSecret } = opts;

  fastify.addHook("preHandler", makeBearerAuth(internalSecret));

  fastify.post<{ Params: { id: string }; Body: EventBody }>(
    "/workers/:id/events",
    async (req: FastifyRequest<{ Params: { id: string }; Body: EventBody }>, reply: FastifyReply) => {
      const { id } = req.params;
      const { type, ts, event, data, level, fields } = req.body ?? {};

      if (!type || !ts) {
        return reply.code(400).send({ ok: false, error: "missing type or ts" });
      }

      const appended = registry.appendEvent(id, { type, ts, event, data, level, fields });
      if (!appended) {
        return reply.code(404).send({ ok: false, error: "worker_not_found" });
      }

      return reply.code(202).send({ ok: true, seq: appended.seq });
    }
  );
};

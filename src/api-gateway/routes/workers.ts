import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { makeBearerAuth } from "../auth.js";
import type { WorkerRegistry, WorkerEvent } from "../worker-registry.js";

type WorkersPluginOpts = { registry: WorkerRegistry; apiKey: string };

function sendFrame(raw: NodeJS.WritableStream, data: unknown): void {
  const json = JSON.stringify(data);
  const seq = (data as WorkerEvent).seq;
  const idLine = typeof seq === "number" ? `id: ${seq}\n` : "";
  raw.write(`${idLine}data: ${json}\n\n`);
}

export const workersRoutes: FastifyPluginAsync<WorkersPluginOpts> = async (fastify, opts) => {
  const { registry, apiKey } = opts;

  fastify.addHook("preHandler", makeBearerAuth(apiKey));

  fastify.get("/workers", async (_req, reply) => {
    return reply.send({ workers: registry.list() });
  });

  fastify.get<{ Params: { id: string } }>(
    "/workers/:id/stream",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const record = registry.get(req.params.id);
      if (!record) {
        return reply.code(404).send({ ok: false, error: "worker_not_found" });
      }
      // Capture in a const so TypeScript narrows through closures below.
      const workerRecord = record;

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      // Replay buffered events
      for (const ev of workerRecord.events) sendFrame(raw, ev);

      // Worker already finished — close immediately after replay
      if (workerRecord.finishedAt) {
        sendFrame(raw, { type: "stream.closed", reason: "worker_finished" });
        raw.end();
        return;
      }

      // Subscribe for live events
      const onEvent = (ev: WorkerEvent) => sendFrame(raw, ev);
      workerRecord.emitter.on("event", onEvent);

      const onFinished = () => {
        sendFrame(raw, { type: "stream.closed", reason: "worker_finished" });
        cleanup();
      };
      workerRecord.emitter.once("finished", onFinished);

      const heartbeat = setInterval(() => sendFrame(raw, { type: "heartbeat" }), 15_000);

      function cleanup() {
        clearInterval(heartbeat);
        workerRecord.emitter.off("event", onEvent);
        workerRecord.emitter.off("finished", onFinished);
        raw.end();
      }

      req.raw.on("close", cleanup);
    }
  );
};

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

function pad(a: string, b: string): [Buffer, Buffer] {
  const len = Math.max(Buffer.byteLength(a), Buffer.byteLength(b));
  const ba = Buffer.alloc(len);
  const bb = Buffer.alloc(len);
  ba.write(a);
  bb.write(b);
  return [ba, bb];
}

export function safeCompare(a: string, b: string): boolean {
  const [ba, bb] = pad(a, b);
  return timingSafeEqual(ba, bb);
}

export function makeBearerAuth(expected: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = (req.headers.authorization as string | undefined) ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!safeCompare(token, expected)) {
      return reply.code(401).send({ ok: false, error: "unauthorized" }) as unknown as void;
    }
  };
}

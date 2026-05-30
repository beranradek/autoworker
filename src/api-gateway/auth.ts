import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Constant-time string comparison that is safe against timing attacks even when
 * the two inputs differ in byte length.  Both strings are encoded to UTF-8 and
 * zero-padded to the same length *before* the constant-time compare so that:
 * 1. `timingSafeEqual` always receives equal-length buffers (required by Node.js).
 * 2. An empty `expected` value never matches any token (guards against an
 *    unconfigured API_KEY defaulting to `""` and thereby bypassing auth).
 */
export function safeCompare(a: string, b: string): boolean {
  // Reject immediately when the expected secret is empty – an unconfigured key
  // must never authenticate anything.
  if (!b) return false;

  // Encode both strings and pad the shorter one with zeros so both buffers have
  // the same length.  Buffer.alloc() already zero-fills, so writing only the
  // shorter string's bytes leaves the tail as zeros – identical for both
  // buffers when the strings match.  timingSafeEqual then compares in O(len).
  const la = Buffer.byteLength(a);
  const lb = Buffer.byteLength(b);
  const len = Math.max(la, lb);
  const ba = Buffer.alloc(len);
  const bb = Buffer.alloc(len);
  // Use copy() instead of write() so the copy length is always `len` worth of
  // work: we write the source bytes and leave the rest as the zeros from alloc.
  Buffer.from(a).copy(ba);
  Buffer.from(b).copy(bb);
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

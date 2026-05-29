import crypto from "node:crypto";

/**
 * Verify a GitHub webhook payload against the shared secret using the
 * `X-Hub-Signature-256` header (HMAC-SHA256 over the raw request body).
 *
 * The comparison is constant-time to avoid leaking the expected digest through
 * timing. The raw body bytes (not a re-serialized JSON object) must be passed,
 * since GitHub computes the HMAC over the exact bytes it sent.
 */
export function verifySignature(secret: string, body: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  const provided = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so guard first.
  if (provided.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuf);
}

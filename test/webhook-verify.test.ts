import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { verifySignature } from "../src/webhook/verify.js";

function sign(secret: string, body: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifySignature", () => {
  const secret = "s3cr3t";
  const body = Buffer.from(JSON.stringify({ hello: "world" }));

  it("accepts a correct signature", () => {
    expect(verifySignature(secret, body, sign(secret, body))).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(verifySignature(secret, body, sign("wrong", body))).toBe(false);
  });

  it("rejects a tampered body", () => {
    const sig = sign(secret, body);
    expect(verifySignature(secret, Buffer.from("tampered"), sig)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifySignature(secret, body, undefined)).toBe(false);
  });

  it("rejects a malformed signature without throwing", () => {
    expect(verifySignature(secret, body, "garbage")).toBe(false);
    expect(verifySignature(secret, body, "sha256=short")).toBe(false);
  });
});

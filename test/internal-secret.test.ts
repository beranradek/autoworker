import { describe, expect, it } from "vitest";
import { internalWorkerSecret } from "../src/api-gateway/internal-secret.js";

describe("internalWorkerSecret", () => {
  it("is a 64-character hex string", () => {
    expect(internalWorkerSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is consistent across imports (module singleton)", async () => {
    const { internalWorkerSecret: same } = await import("../src/api-gateway/internal-secret.js");
    expect(internalWorkerSecret).toBe(same);
  });
});

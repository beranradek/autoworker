import { describe, expect, it } from "vitest";
import { makeJobName } from "../src/job-runner/aca.js";

describe("makeJobName", () => {
  it("produces a name within 32 chars for normal prefix and correlationId", () => {
    const name = makeJobName("issue-agent", "owner-repo-42-1716900000000");
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it("preserves the timestamp suffix (rightmost component) for uniqueness", () => {
    const name = makeJobName("issue-agent", "pr-review-owner-repo-42-1716900000000");
    expect(name).toContain("1716900000000");
    expect(name.length).toBeLessThanOrEqual(32);
  });

  it("does not produce a leading or trailing hyphen", () => {
    const name = makeJobName("issue-agent", "pr-review-owner-repo-42-1716900000000");
    expect(name).not.toMatch(/^-|-$/);
  });

  it("handles a 31-char prefix without overflowing via slice(-0)", () => {
    // When prefix is 31 chars, jobPrefix = 32 chars, maxSuffixLen = 0.
    // Before the fix, slice(-0) === slice(0) returned the full suffix string,
    // blowing past the 32-char Azure limit.
    const longPrefix = "a".repeat(31);
    const name = makeJobName(longPrefix, "owner-repo-42-1716900000000");
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).not.toMatch(/-$/);
  });

  it("handles a 30-char prefix without overflowing (maxSuffixLen=1)", () => {
    const prefix30 = "a".repeat(30);
    const name = makeJobName(prefix30, "owner-repo-42-1716900000000");
    expect(name.length).toBeLessThanOrEqual(32);
  });

  it("strips leading hyphens from sliced suffix", () => {
    // When suffix after slicing starts with '-', it must be stripped so the
    // result does not contain '--' at the prefix/suffix boundary.
    const name = makeJobName("issue-agent", "pr-review-x-y-1234567890123456789");
    expect(name).not.toContain("--");
    expect(name.length).toBeLessThanOrEqual(32);
  });

  it("handles single-char correlationId", () => {
    const name = makeJobName("issue-agent", "x");
    expect(name).toBe("issue-agent-x");
    expect(name.length).toBeLessThanOrEqual(32);
  });
});

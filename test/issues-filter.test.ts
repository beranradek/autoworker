import { describe, expect, it } from "vitest";
import { hasAnyLabel } from "../src/github/issues.js";

describe("hasAnyLabel", () => {
  it("matches case-insensitively", () => {
    const issue = { labels: ["In-Progress"] } as any;
    expect(hasAnyLabel(issue, ["in-progress"])).toBe(true);
  });

  it("returns false when none match", () => {
    const issue = { labels: ["triage"] } as any;
    expect(hasAnyLabel(issue, ["in-progress", "pr-created"])).toBe(false);
  });

  it("matches when one of multiple labels is present", () => {
    const issue = { labels: ["pr-created", "some-other"] } as any;
    expect(hasAnyLabel(issue, ["in-progress", "pr-created"])).toBe(true);
  });
});


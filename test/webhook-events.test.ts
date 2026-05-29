import { describe, expect, it } from "vitest";
import { parseWebhookEvent } from "../src/webhook/events.js";

describe("parseWebhookEvent", () => {
  it("parses an issues event", () => {
    const parsed = parseWebhookEvent("issues", {
      action: "opened",
      issue: { number: 42 },
      repository: { full_name: "owner/repo" }
    });
    expect(parsed).toEqual({
      repoFullName: "owner/repo",
      eventType: "issues",
      action: "opened",
      number: 42,
      summary: "issues.opened #42"
    });
  });

  it("parses an issue_comment event (number from issue)", () => {
    const parsed = parseWebhookEvent("issue_comment", {
      action: "created",
      issue: { number: 7 },
      repository: { full_name: "owner/repo" }
    });
    expect(parsed?.number).toBe(7);
    expect(parsed?.summary).toBe("issue_comment.created #7");
  });

  it("parses a pull_request event (number from pull_request)", () => {
    const parsed = parseWebhookEvent("pull_request", {
      action: "opened",
      pull_request: { number: 99 },
      repository: { full_name: "owner/repo" }
    });
    expect(parsed?.number).toBe(99);
    expect(parsed?.eventType).toBe("pull_request");
  });

  it("parses a pull_request_review event", () => {
    const parsed = parseWebhookEvent("pull_request_review", {
      action: "submitted",
      pull_request: { number: 12 },
      repository: { full_name: "owner/repo" }
    });
    expect(parsed?.summary).toBe("pull_request_review.submitted #12");
  });

  it("returns null for irrelevant event types", () => {
    expect(parseWebhookEvent("push", { repository: { full_name: "owner/repo" } })).toBeNull();
    expect(parseWebhookEvent("star", { repository: { full_name: "owner/repo" } })).toBeNull();
  });

  it("returns null when event type is missing", () => {
    expect(parseWebhookEvent(undefined, { repository: { full_name: "owner/repo" } })).toBeNull();
  });

  it("returns null when repository full_name is missing or malformed", () => {
    expect(parseWebhookEvent("issues", { action: "opened", issue: { number: 1 } })).toBeNull();
    expect(parseWebhookEvent("issues", { repository: { full_name: "no-slash" } })).toBeNull();
  });

  it("tolerates a missing number", () => {
    const parsed = parseWebhookEvent("issues", {
      action: "opened",
      repository: { full_name: "owner/repo" }
    });
    expect(parsed?.number).toBeUndefined();
    expect(parsed?.summary).toBe("issues.opened");
  });
});

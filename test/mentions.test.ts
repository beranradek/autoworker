import { describe, expect, it } from "vitest";
import { containsMention } from "../src/github/mentions.js";

describe("containsMention", () => {
  it("matches case-insensitively", () => {
    expect(containsMention("Ping @Worker please", "@worker")).toBe(true);
  });

  it("does not match as substring", () => {
    expect(containsMention("Ping @workerr please", "@worker")).toBe(false);
  });

  it("matches at start", () => {
    expect(containsMention("@worker do it", "@worker")).toBe(true);
  });

  it("matches with punctuation after", () => {
    expect(containsMention("Please @worker, handle this", "@worker")).toBe(true);
  });

  it("matches with period after", () => {
    expect(containsMention("ping @worker.", "@worker")).toBe(true);
  });

  it("matches at end of string", () => {
    expect(containsMention("ping @worker", "@worker")).toBe(true);
  });

  it("does not match hyphenated extension: @worker-bot should not trigger @worker", () => {
    expect(containsMention("ping @worker-bot please", "@worker")).toBe(false);
  });

  it("does not match numeric extension: @worker123 should not trigger @worker", () => {
    expect(containsMention("cc @worker123", "@worker")).toBe(false);
  });

  it("does not match when mention is not preceded by start or whitespace", () => {
    expect(containsMention("see_@worker_here", "@worker")).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(containsMention("", "@worker")).toBe(false);
  });

  it("returns false for empty mention", () => {
    expect(containsMention("ping @worker", "")).toBe(false);
  });
});


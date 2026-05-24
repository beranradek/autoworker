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
});


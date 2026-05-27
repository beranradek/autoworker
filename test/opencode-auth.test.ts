import { describe, expect, it } from "vitest";
import { validateOpencodeAuthJson } from "../src/opencode-auth.js";

const NOW = 1_000_000_000_000;

describe("validateOpencodeAuthJson", () => {
  it("reports a valid (unexpired) oauth provider", () => {
    const raw = JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: NOW + 60_000 } });
    const v = validateOpencodeAuthJson(raw, NOW);
    expect(v.providers).toEqual(["anthropic"]);
    expect(v.oauthProviders).toEqual(["anthropic"]);
    expect(v.expiredOauthProviders).toEqual([]);
    expect(v.missingRefresh).toEqual([]);
  });

  it("flags an expired access token", () => {
    const raw = JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: NOW - 1 } });
    const v = validateOpencodeAuthJson(raw, NOW);
    expect(v.expiredOauthProviders).toEqual(["anthropic"]);
  });

  it("flags a missing refresh token", () => {
    const raw = JSON.stringify({ anthropic: { type: "oauth", access: "a", expires: NOW + 60_000 } });
    const v = validateOpencodeAuthJson(raw, NOW);
    expect(v.missingRefresh).toEqual(["anthropic"]);
  });

  it("ignores non-oauth (api key) entries", () => {
    const raw = JSON.stringify({ openai: { type: "api", key: "x" } });
    const v = validateOpencodeAuthJson(raw, NOW);
    expect(v.providers).toEqual(["openai"]);
    expect(v.oauthProviders).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    expect(() => validateOpencodeAuthJson("{not json", NOW)).toThrow(/not valid JSON/);
  });

  it("throws on an empty object", () => {
    expect(() => validateOpencodeAuthJson("{}", NOW)).toThrow(/no provider credentials/);
  });

  it("throws on a non-object payload", () => {
    expect(() => validateOpencodeAuthJson("[]", NOW)).toThrow(/must be a JSON object/);
  });
});

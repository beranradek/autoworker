// Non-destructive validation of OpenCode's auth.json contents (the value carried
// in OPENCODE_AUTH_JSON). Parses and inspects the credentials so misconfiguration
// can be surfaced early in logs — it never calls the network or refreshes tokens.

export type OpencodeAuthValidation = {
  providers: string[];
  oauthProviders: string[];
  expiredOauthProviders: string[];
  missingRefresh: string[];
};

export function validateOpencodeAuthJson(raw: string, now: number = Date.now()): OpencodeAuthValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`OPENCODE_AUTH_JSON is not valid JSON: ${String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENCODE_AUTH_JSON must be a JSON object of provider credentials");
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("OPENCODE_AUTH_JSON has no provider credentials");
  }

  const providers: string[] = [];
  const oauthProviders: string[] = [];
  const expiredOauthProviders: string[] = [];
  const missingRefresh: string[] = [];

  for (const [provider, value] of entries) {
    providers.push(provider);
    if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (v.type === "oauth") {
        oauthProviders.push(provider);
        if (!v.refresh) missingRefresh.push(provider);
        const expires = Number(v.expires ?? 0);
        if (expires > 0 && expires <= now) expiredOauthProviders.push(provider);
      }
    }
  }

  return { providers, oauthProviders, expiredOauthProviders, missingRefresh };
}

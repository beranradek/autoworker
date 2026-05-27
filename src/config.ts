import { z } from "zod";

const schema = z.object({
  GH_TOKEN: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  // Comma/whitespace-separated list of "owner/repo" (can contain a single entry)
  GITHUB_REPOS: z.string().min(1),

  JOB_RUNNER: z.enum(["local-docker", "aca"]).default("local-docker"),

  WORKER_MENTION: z.string().default("@worker"),
  LABEL_ACCEPTED: z.string().default("accepted"),
  LABEL_IN_PROGRESS: z.string().default("in-progress"),
  LABEL_DONE: z.string().default("done"),

  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  MAX_ACCEPT_PER_RUN: z.coerce.number().int().positive().default(1),
  MAX_CONCURRENT_WORKERS: z.coerce.number().int().positive().max(20).default(5),
  DRY_RUN: z
    .enum(["0", "1", "true", "false"])
    .default("false")
    .transform((v) => v === "1" || v === "true"),

  AZURE_SUBSCRIPTION_ID: z.string().optional(),
  AZURE_RESOURCE_GROUP: z.string().optional(),
  AZURE_LOCATION: z.string().optional(),
  AZURE_USE_MANAGED_IDENTITY: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true")
    .default(false),
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),
  AZURE_UAMI_ID: z.string().optional(),

  ACA_ENV_NAME: z.string().optional(),
  ACA_JOB_NAME: z.string().min(1).default("issue-agent"),
  WORKER_IMAGE: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Azure OpenAI via OpenCode: it reads AZURE_API_KEY + AZURE_RESOURCE_NAME
  // (the *.openai.azure.com subdomain), not the full endpoint URL.
  AZURE_API_KEY: z.string().optional(),
  AZURE_RESOURCE_NAME: z.string().optional(),
  // Claude (or any provider) subscription auth: the full contents of OpenCode's
  // auth.json, produced by `opencode auth login`. When set, OpenCode uses the
  // stored OAuth subscription credentials instead of a per-token API key.
  OPENCODE_AUTH_JSON: z.string().optional(),
  LLM_MODEL: z.string().default("openai/gpt-5-mini"),

  CREATE_JOB_IF_MISSING: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true")
    .default(false)
});

type RawConfig = z.infer<typeof schema>;
export type Config = Omit<RawConfig, "GITHUB_TOKEN" | "OPENAI_API_KEY"> & {
  GITHUB_TOKEN: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  AZURE_API_KEY?: string;
  AZURE_RESOURCE_NAME?: string;
  OPENCODE_AUTH_JSON?: string;
};

export function getConfig(): Config {
  const env = { ...process.env } as Record<string, string | undefined>;
  if (!env.GITHUB_TOKEN && env.GH_TOKEN) env.GITHUB_TOKEN = env.GH_TOKEN;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (!parsed.data.GITHUB_TOKEN) {
    throw new Error("Missing GitHub auth: provide GITHUB_TOKEN (or GH_TOKEN)");
  }
  if (parsed.data.JOB_RUNNER === "aca") {
    if (!parsed.data.AZURE_SUBSCRIPTION_ID || !parsed.data.AZURE_RESOURCE_GROUP || !parsed.data.AZURE_LOCATION || !parsed.data.ACA_ENV_NAME) {
      throw new Error("ACA runner requires AZURE_SUBSCRIPTION_ID + AZURE_RESOURCE_GROUP + AZURE_LOCATION + ACA_ENV_NAME");
    }
    if (!parsed.data.AZURE_USE_MANAGED_IDENTITY) {
      if (!parsed.data.AZURE_TENANT_ID || !parsed.data.AZURE_CLIENT_ID || !parsed.data.AZURE_CLIENT_SECRET) {
        throw new Error(
          "Azure auth config missing: either set AZURE_USE_MANAGED_IDENTITY=true, or provide AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET"
        );
      }
    }
  }
  if (!parsed.data.DRY_RUN) {
    if (!parsed.data.WORKER_IMAGE) {
      throw new Error("Worker config missing: provide WORKER_IMAGE (or set DRY_RUN=true for claim-only mode)");
    }
    if (parsed.data.AZURE_API_KEY && !parsed.data.AZURE_RESOURCE_NAME) {
      throw new Error("Worker config missing: AZURE_RESOURCE_NAME is required when AZURE_API_KEY is set");
    }
    const hasOpenAiKey = Boolean(parsed.data.OPENAI_API_KEY);
    const hasAnthropicKey = Boolean(parsed.data.ANTHROPIC_API_KEY);
    const hasAzureKey = Boolean(parsed.data.AZURE_API_KEY && parsed.data.AZURE_RESOURCE_NAME);
    const hasSubscriptionAuth = Boolean(parsed.data.OPENCODE_AUTH_JSON);
    if (!hasOpenAiKey && !hasAnthropicKey && !hasAzureKey && !hasSubscriptionAuth) {
      throw new Error(
        "Worker config missing: provide OPENCODE_AUTH_JSON (subscription auth), OPENAI_API_KEY, ANTHROPIC_API_KEY, or both AZURE_API_KEY + AZURE_RESOURCE_NAME (or set DRY_RUN=true for claim-only mode)"
      );
    }
  }
  return parsed.data as Config;
}

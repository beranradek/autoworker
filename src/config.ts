import { z } from "zod";

const schema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),

  WORKER_MENTION: z.string().default("@worker"),
  LABEL_ACCEPTED: z.string().default("accepted"),
  LABEL_IN_PROGRESS: z.string().default("in-progress"),
  LABEL_DONE: z.string().default("done"),

  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  MAX_ACCEPT_PER_RUN: z.coerce.number().int().positive().default(1),
  DRY_RUN: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),

  AZURE_SUBSCRIPTION_ID: z.string().min(1),
  AZURE_RESOURCE_GROUP: z.string().min(1),
  AZURE_LOCATION: z.string().min(1),
  AZURE_USE_MANAGED_IDENTITY: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true")
    .default(false),
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),

  ACA_ENV_NAME: z.string().min(1),
  ACA_JOB_NAME: z.string().min(1),
  WORKER_IMAGE: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),

  CREATE_JOB_IF_MISSING: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true")
    .default(false)
});

export type Config = z.infer<typeof schema>;

export function getConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (!parsed.data.AZURE_USE_MANAGED_IDENTITY) {
    if (!parsed.data.AZURE_TENANT_ID || !parsed.data.AZURE_CLIENT_ID || !parsed.data.AZURE_CLIENT_SECRET) {
      throw new Error(
        "Azure auth config missing: either set AZURE_USE_MANAGED_IDENTITY=true, or provide AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET"
      );
    }
  }
  return parsed.data;
}

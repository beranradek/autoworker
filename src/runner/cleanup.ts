import { execFileSync } from "node:child_process";
import { getConfig } from "../config.js";
import { log } from "../log.js";
import { createAcaClient } from "../azure/client.js";
import type { Config } from "../config.js";

function parseDockerDate(s: string): Date {
  const normalized = s.replace(/\s+[A-Z]{2,5}$/, "");
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

export type ExecDockerFn = (args: string[]) => string;

export function defaultExecDocker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" });
}

export function cleanupDockerContainers(
  cutoffMs: number,
  dryRun: boolean,
  execDocker: ExecDockerFn = defaultExecDocker
): void {
  let psOutput: string;
  try {
    psOutput = execDocker([
      "ps",
      "--all",
      "--filter",
      "label=autoworker.managed=true",
      "--filter",
      "status=exited",
      "--format",
      "{{json .}}"
    ]);
  } catch (err: unknown) {
    log("warn", "cleanup.docker.unavailable", { error: String((err as { message?: string })?.message ?? err) });
    return;
  }
  const lines = psOutput.split("\n").filter(Boolean);
  let removed = 0;
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = (entry.Names as string).replace(/^\//, "");
    const createdAt = parseDockerDate(entry.CreatedAt as string);
    if (createdAt.getTime() > cutoffMs) continue;
    log("info", "cleanup_docker.candidate", { name, createdAt: createdAt.toISOString() });
    if (dryRun) continue;
    try {
      execDocker(["rm", name]);
      removed += 1;
      log("info", "cleanup_docker.removed", { name });
    } catch (rmErr: unknown) {
      log("warn", "cleanup.docker.rm_failed", { name, error: String((rmErr as { message?: string })?.message ?? rmErr) });
    }
  }
  log("info", "cleanup_docker.done", { removed, total: lines.length });
}

function parseTimestampFromJobName(name: string): Date | null {
  const m = name.match(/-issue-\d+-([0-9]{8}t?[0-9]{6}z?)$/i);
  if (!m) return null;
  const raw = m[1].toLowerCase().replace("t", "");
  const s = raw.endsWith("z") ? raw.slice(0, -1) : raw;
  if (s.length !== 14) return null;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10));
  const mi = Number(s.slice(10, 12));
  const se = Number(s.slice(12, 14));
  if ([y, mo, d, h, mi, se].some((n) => Number.isNaN(n))) return null;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se));
}

async function cleanupAcaJobs(cfg: Config, cutoffHours: number, dryRun: boolean): Promise<void> {
  const cutoff = Date.now() - cutoffHours * 60 * 60 * 1000;
  const prefix = `${cfg.ACA_JOB_NAME}-issue-`.toLowerCase();

  const aca = createAcaClient({
    subscriptionId: cfg.AZURE_SUBSCRIPTION_ID!,
    useManagedIdentity: cfg.AZURE_USE_MANAGED_IDENTITY,
    tenantId: cfg.AZURE_TENANT_ID,
    clientId: cfg.AZURE_CLIENT_ID,
    clientSecret: cfg.AZURE_CLIENT_SECRET
  });

  log("info", "cleanup.start", { resourceGroup: cfg.AZURE_RESOURCE_GROUP, prefix, cutoffHours, dryRun });

  const jobs: any[] = [];
  for await (const j of aca.jobs.listByResourceGroup(cfg.AZURE_RESOURCE_GROUP!) as any) {
    jobs.push(j);
  }

  let deleted = 0;
  for (const j of jobs) {
    const name = String(j?.name ?? "");
    if (!name.toLowerCase().startsWith(prefix)) continue;
    const ts = parseTimestampFromJobName(name);
    if (!ts) continue;
    if (ts.getTime() > cutoff) continue;

    log("info", "cleanup.delete_candidate", { jobName: name, createdAt: ts.toISOString() });
    if (dryRun) continue;

    await aca.jobs.beginDeleteAndWait(cfg.AZURE_RESOURCE_GROUP!, name);
    deleted += 1;
    log("info", "cleanup.deleted", { jobName: name });
  }

  log("info", "cleanup.done", { deleted, total: jobs.length });
}

export async function cleanupJobs(): Promise<void> {
  const cfg = getConfig();
  const dryRun = Boolean(cfg.DRY_RUN);
  const cutoffHours = Number(process.env.CLEANUP_AFTER_HOURS ?? "48");

  if (cfg.JOB_RUNNER === "aca") {
    await cleanupAcaJobs(cfg, cutoffHours, dryRun);
  } else {
    const cutoffMs = Date.now() - cutoffHours * 3600 * 1000;
    cleanupDockerContainers(cutoffMs, dryRun);
  }
}

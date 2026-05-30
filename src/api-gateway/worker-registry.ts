import { EventEmitter } from "node:events";

export type WorkerMode = "implementation" | "pr-review";

export type WorkerEvent = {
  seq: number;
  ts: string;
  type: "lifecycle" | "log";
  event?: string;
  data?: Record<string, unknown>;
  level?: string;
  fields?: Record<string, unknown>;
};

export type WorkerRecord = {
  correlationId: string;
  mode: WorkerMode;
  issueUrl: string;
  issue: string;
  runner: "local-docker" | "aca";
  startedAt: string;
  finishedAt?: string;
  outcome?: "success" | "failed";
  error?: string;
  events: WorkerEvent[];
  emitter: EventEmitter;
  expiresAt?: number;
};

export type WorkerSummary = {
  correlationId: string;
  mode: WorkerMode;
  issueUrl: string;
  issue: string;
  runner: "local-docker" | "aca";
  startedAt: string;
  finishedAt?: string;
  outcome?: "success" | "failed";
  error?: string;
  eventCount: number;
  active: boolean;
};

export type RegisterInput = {
  correlationId: string;
  mode: WorkerMode;
  issueUrl: string;
  issue: string;
  runner: "local-docker" | "aca";
};

const RETENTION_MS = 24 * 60 * 60 * 1000;
const EVICTION_INTERVAL_MS = 5 * 60 * 1000;

export class WorkerRegistry {
  private readonly records = new Map<string, WorkerRecord>();
  private evictionTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.evictionTimer = setInterval(() => this.evictNow(), EVICTION_INTERVAL_MS);
    this.evictionTimer.unref?.();
  }

  register(input: RegisterInput): WorkerRecord {
    const record: WorkerRecord = {
      correlationId: input.correlationId,
      mode: input.mode,
      issueUrl: input.issueUrl,
      issue: input.issue,
      runner: input.runner,
      startedAt: new Date().toISOString(),
      events: [],
      emitter: new EventEmitter()
    };
    this.records.set(input.correlationId, record);
    return record;
  }

  get(correlationId: string): WorkerRecord | undefined {
    return this.records.get(correlationId);
  }

  appendEvent(correlationId: string, raw: Omit<WorkerEvent, "seq">): WorkerEvent | undefined {
    const record = this.records.get(correlationId);
    if (!record) return undefined;

    const event: WorkerEvent = { ...raw, seq: record.events.length + 1 };
    record.events.push(event);
    record.emitter.emit("event", event);

    if (raw.type === "lifecycle" && raw.event === "worker.finished") {
      record.finishedAt = new Date().toISOString();
      record.outcome = (raw.data?.outcome as string) === "success" ? "success" : "failed";
      if (raw.data?.error) record.error = raw.data.error as string;
      record.expiresAt = Date.now() + RETENTION_MS;
      record.emitter.emit("finished");
    }

    return event;
  }

  list(): WorkerSummary[] {
    const all = Array.from(this.records.values());
    const toSummary = (r: WorkerRecord): WorkerSummary => ({
      correlationId: r.correlationId,
      mode: r.mode,
      issueUrl: r.issueUrl,
      issue: r.issue,
      runner: r.runner,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      outcome: r.outcome,
      error: r.error,
      eventCount: r.events.length,
      active: !r.finishedAt
    });
    const active = all.filter((r) => !r.finishedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const finished = all.filter((r) => r.finishedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return [...active, ...finished].map(toSummary);
  }

  evictNow(): void {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt != null && now > record.expiresAt) {
        record.emitter.removeAllListeners();
        this.records.delete(id);
      }
    }
  }

  destroy(): void {
    if (this.evictionTimer) clearInterval(this.evictionTimer);
    for (const record of this.records.values()) {
      record.emitter.removeAllListeners();
    }
    this.records.clear();
  }
}

export const workerRegistry = new WorkerRegistry();

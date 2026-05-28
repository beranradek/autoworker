export type WorkerLastStatus = {
  correlationId: string;
  issue: string;
  issueUrl: string;
  runner: "local-docker" | "aca";
  startedAt: string;
  finishedAt?: string;
  outcome?: "success" | "failed";
  error?: string;
};

export type PollStatus = {
  startedAt?: string;
  finishedAt?: string;
  lastOkAt?: string;
  lastError?: string;
};

export type AppStatus = {
  processStartedAt: string;
  poll: PollStatus;
  lastWorker?: WorkerLastStatus;
};

const state: AppStatus = {
  processStartedAt: new Date().toISOString(),
  poll: {}
};

export function getStatus(): AppStatus {
  return state;
}

export function markPollStart(): void {
  state.poll.startedAt = new Date().toISOString();
}

export function markPollDoneOk(): void {
  const now = new Date().toISOString();
  state.poll.finishedAt = now;
  state.poll.lastOkAt = now;
  state.poll.lastError = undefined;
}

export function markPollDoneError(err: unknown): void {
  state.poll.finishedAt = new Date().toISOString();
  state.poll.lastError = String(err);
}

export function markWorkerStart(input: {
  correlationId: string;
  issue: string;
  issueUrl: string;
  runner: "local-docker" | "aca";
}): void {
  state.lastWorker = {
    correlationId: input.correlationId,
    issue: input.issue,
    issueUrl: input.issueUrl,
    runner: input.runner,
    startedAt: new Date().toISOString()
  };
}

export function markWorkerDoneOk(correlationId: string): void {
  if (!state.lastWorker || state.lastWorker.correlationId !== correlationId) return;
  state.lastWorker.finishedAt = new Date().toISOString();
  state.lastWorker.outcome = "success";
  state.lastWorker.error = undefined;
}

export function markWorkerDoneError(correlationId: string, err: unknown): void {
  if (!state.lastWorker || state.lastWorker.correlationId !== correlationId) return;
  state.lastWorker.finishedAt = new Date().toISOString();
  state.lastWorker.outcome = "failed";
  state.lastWorker.error = String(err);
}


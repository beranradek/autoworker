export type PollStatus = {
  startedAt?: string;
  finishedAt?: string;
  lastOkAt?: string;
  lastError?: string;
};

export type WebhookStatus = {
  enabled: boolean;
  received: number;
  enqueued: number;
  processed: number;
  queueDepth: number;
  lastEventType?: string;
  lastEventAt?: string;
  lastProcessedRepo?: string;
  lastProcessedAt?: string;
  lastError?: string;
};

export type AppStatus = {
  processStartedAt: string;
  poll: PollStatus;
  webhook?: WebhookStatus;
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

function webhook(): WebhookStatus {
  if (!state.webhook) {
    state.webhook = { enabled: false, received: 0, enqueued: 0, processed: 0, queueDepth: 0 };
  }
  return state.webhook;
}

export function setWebhookEnabled(enabled: boolean): void {
  webhook().enabled = enabled;
}

export function markWebhookReceived(eventType: string): void {
  const w = webhook();
  w.received += 1;
  w.lastEventType = eventType;
  w.lastEventAt = new Date().toISOString();
}

export function markWebhookEnqueued(queueDepth: number): void {
  const w = webhook();
  w.enqueued += 1;
  w.queueDepth = queueDepth;
}

export function setQueueDepth(queueDepth: number): void {
  webhook().queueDepth = queueDepth;
}

export function markWebhookProcessed(repoKey: string, queueDepth: number): void {
  const w = webhook();
  w.processed += 1;
  w.queueDepth = queueDepth;
  w.lastProcessedRepo = repoKey;
  w.lastProcessedAt = new Date().toISOString();
  w.lastError = undefined;
}

export function markWebhookError(err: unknown): void {
  webhook().lastError = String(err);
}

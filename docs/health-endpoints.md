# Health / readiness endpoints

When autoworker is running, it exposes:

- `GET /healthz` → `{ ok: true, status: … }`
- `GET /readyz` → `{ ok: true, status: … }`

The `status` payload includes:

- `processStartedAt`
- `poll.startedAt`, `poll.finishedAt`, `poll.lastOkAt`, `poll.lastError`
- `webhook` (in `serve` mode): `enabled`, `received`, `enqueued`, `processed`, `queueDepth`, `lastEventType`, `lastEventAt`, `lastProcessedRepo`, `lastProcessedAt`, `lastError`
- `lastWorker` (last started worker): `correlationId`, `issue`, `issueUrl`, `runner`, `startedAt`, `finishedAt`, `outcome`, `error`

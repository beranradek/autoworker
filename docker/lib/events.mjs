// Event push helper — sends lifecycle and log events to the orchestrator API.
// All functions are fire-and-forget; the worker never fails because of push errors.
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL || "";
const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "";
const CORRELATION_ID = process.env.CORRELATION_ID || "";

function nowIso() {
  return new Date().toISOString();
}

async function push(payload) {
  if (!ORCHESTRATOR_URL || !CORRELATION_ID) return;
  try {
    await fetch(`${ORCHESTRATOR_URL}/internal/workers/${encodeURIComponent(CORRELATION_ID)}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${INTERNAL_SECRET}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    // best-effort: never propagate push errors to the worker
  }
}

export function emitEvent(event, data = {}) {
  push({ type: "lifecycle", event, data, ts: nowIso() }).catch(() => {});
}

export async function emitEventAndWait(event, data = {}) {
  await push({ type: "lifecycle", event, data, ts: nowIso() });
}

export function emitLog(level, event, fields = {}) {
  push({ type: "log", level, event, fields, ts: nowIso() }).catch(() => {});
}

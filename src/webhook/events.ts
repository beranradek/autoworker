/**
 * GitHub webhook event types the orchestrator reacts to. Each maps onto one of
 * the orchestration steps:
 *   - issues / issue_comment    → implementation (issue opened/edited, @worker mention)
 *   - pull_request              → PR review (PR opened/edited)
 *   - pull_request_review*      → PR merge (review approved)
 *
 * All other event types (push, star, ...) are ignored.
 */
const RELEVANT_EVENTS = new Set([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment"
]);

export type ParsedWebhook = {
  /** "owner/repo" from the payload's repository object. */
  repoFullName: string;
  eventType: string;
  action?: string;
  /** Issue or PR number, when present (used only for logging). */
  number?: number;
  /** Short description for logs, e.g. "issues.opened #42". */
  summary: string;
};

/**
 * Normalize a raw GitHub webhook into the fields the orchestrator needs, or
 * return null when the event is not one we act on. Orchestration is a full repo
 * scan, so we only need the repo identity — the specific action and number are
 * carried through for observability.
 */
export function parseWebhookEvent(eventType: string | undefined, payload: unknown): ParsedWebhook | null {
  if (!eventType || !RELEVANT_EVENTS.has(eventType)) return null;
  if (!payload || typeof payload !== "object") return null;

  const p = payload as Record<string, any>;
  const repoFullName = p.repository?.full_name;
  if (typeof repoFullName !== "string" || !repoFullName.includes("/")) return null;

  const action = typeof p.action === "string" ? p.action : undefined;

  let number: number | undefined;
  if (eventType === "issues" || eventType === "issue_comment") {
    number = typeof p.issue?.number === "number" ? p.issue.number : undefined;
  } else {
    number = typeof p.pull_request?.number === "number" ? p.pull_request.number : undefined;
  }

  const summary = `${eventType}${action ? `.${action}` : ""}${number !== undefined ? ` #${number}` : ""}`;
  return { repoFullName, eventType, action, number, summary };
}

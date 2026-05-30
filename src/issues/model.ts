export type IssueState =
  | 'open'
  | 'in_progress'
  | 'pr_created'
  | 'pr_reviewed'
  | 'closed';

export type CloseReason = 'completed' | 'not_planned' | 'duplicate';
export type PrReviewOutcome = 'approved' | 'rejected' | 'human_needed';

export type Issue = {
  number: number;
  url: string;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  prReviewOutcome?: PrReviewOutcome;
};

/**
 * Minimal information used for selecting the next issues to implement.
 * This intentionally excludes bodies and labels to keep payloads small.
 */
export type PendingIssueInfo = {
  number: number;
  url: string;
  title: string;
  /**
   * Issue numbers that this issue is currently blocked by (dependencies).
   * If empty, the issue is unblocked.
   */
  blockedBy: number[];
  /** True if all dependencies are already closed. */
  ready: boolean;
  /**
   * How many other *pending* issues are blocked by this issue.
   * Higher means implementing this issue likely unblocks more work.
   */
  blocksCount: number;
};

export type PrInfo = {
  number: number;
  url: string;
  branch: string;
  baseBranch: string;
};

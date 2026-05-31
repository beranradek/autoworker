import type { CloseReason, Issue, IssueState, PendingIssueInfo, PrInfo, PrReviewOutcome } from './model.js';

export interface IssueService {
  ensureLabels(): Promise<void>;
  listIssuesByState(state: IssueState): Promise<Issue[]>;
  /**
   * Returns open issues in the initial "open" state (i.e. not in-progress,
   * not pr-created, not in-review, not pr-reviewed, and not closed), ordered
   * by implementation readiness with respect to issue-dependency relationships.
   */
  listPendingIssues(): Promise<PendingIssueInfo[]>;
  transitionTo(
    issue: Issue,
    newState: IssueState,
    opts?: { closeReason?: CloseReason; prReviewOutcome?: PrReviewOutcome }
  ): Promise<void>;
  findLinkedPr(issue: Issue): Promise<PrInfo | null>;
  mergePr(pr: PrInfo): Promise<void>;
  isMentionedByWorker(issue: Issue): Promise<boolean>;
  isInReview(issue: Issue): Promise<boolean>;
  markInReview(issue: Issue): Promise<void>;
  unmarkInReview(issue: Issue): Promise<void>;
  unmarkInProgress(issue: Issue): Promise<void>;
  markUnsatisfiedDependencies(issue: Issue): Promise<void>;
  unmarkUnsatisfiedDependencies(issue: Issue): Promise<void>;
}

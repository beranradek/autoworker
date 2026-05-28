import type { CloseReason, Issue, IssueState, PrInfo, PrReviewOutcome } from './model.js';

export interface IssueService {
  listIssuesByState(state: IssueState): Promise<Issue[]>;
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
}

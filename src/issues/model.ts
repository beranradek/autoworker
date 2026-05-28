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

export type PrInfo = {
  number: number;
  url: string;
  branch: string;
  baseBranch: string;
};

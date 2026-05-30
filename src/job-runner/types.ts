export type ImplementationRunInput = {
  issueUrl: string;
  githubToken: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  azureApiKey?: string;
  azureResourceName?: string;
  opencodeAuthJson?: string;
  workerImage: string;
  correlationId: string;
  llmModel?: string;
  labelInProgress?: string;
  labelPrCreated?: string;
  orchestratorInternalUrl?: string;
  internalWorkerSecret?: string;
};

export type ImplementationRunResult = {
  runner: "local-docker" | "aca";
  jobName?: string;
};

export type PrReviewRunInput = {
  issueUrl: string;
  prUrl: string;
  prBranch: string;
  baseBranch: string;
  githubToken: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  azureApiKey?: string;
  azureResourceName?: string;
  opencodeAuthJson?: string;
  workerImage: string;
  correlationId: string;
  llmModel?: string;
  labelInReview?: string;
  labelPrReviewed?: string;
  labelHumanNeeded?: string;
  orchestratorInternalUrl?: string;
  internalWorkerSecret?: string;
};

export type PrReviewRunResult = {
  runner: "local-docker" | "aca";
  jobName?: string;
};

export interface JobRunner {
  runIssue(input: ImplementationRunInput): Promise<ImplementationRunResult>;
  runPrReview(input: PrReviewRunInput): Promise<PrReviewRunResult>;
}

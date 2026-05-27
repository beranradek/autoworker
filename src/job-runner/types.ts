export type IssueRunInput = {
  issueUrl: string;
  githubToken: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  azureApiKey?: string;
  azureResourceName?: string;
  workerImage: string;
  correlationId: string;
  llmModel?: string;
};

export type IssueRunResult = {
  runner: "local-docker" | "aca";
  jobName?: string;
};

export interface JobRunner {
  runIssue(input: IssueRunInput): Promise<IssueRunResult>;
}

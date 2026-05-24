export type IssueRunInput = {
  issueUrl: string;
  githubToken: string;
  anthropicApiKey: string;
  workerImage: string;
  correlationId: string;
};

export type IssueRunResult = {
  runner: "local-docker" | "aca";
  jobName?: string;
};

export interface JobRunner {
  runIssue(input: IssueRunInput): Promise<IssueRunResult>;
}


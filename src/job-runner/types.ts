export type IssueRunInput = {
  issueUrl: string;
  githubToken: string;
  openaiApiKey: string;
  workerImage: string;
  correlationId: string;
  opencodeModel?: string;
};

export type IssueRunResult = {
  runner: "local-docker" | "aca";
  jobName?: string;
};

export interface JobRunner {
  runIssue(input: IssueRunInput): Promise<IssueRunResult>;
}

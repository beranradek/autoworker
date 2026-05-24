export type RepoRef = { owner: string; repo: string };

export type IssueCandidate = {
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
};


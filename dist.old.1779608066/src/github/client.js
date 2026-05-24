import { Octokit } from "@octokit/rest";
export function createGitHubClient(token) {
    return new Octokit({ auth: token });
}
//# sourceMappingURL=client.js.map
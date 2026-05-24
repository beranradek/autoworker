import { spawn } from "node:child_process";
import { log } from "../log.js";
export class LocalDockerJobRunner {
    spawnFn;
    constructor(spawnFn = spawn) {
        this.spawnFn = spawnFn;
    }
    async runIssue(input) {
        const args = [
            "run",
            "--rm",
            "-e",
            `GH_TOKEN=${input.githubToken}`,
            "-e",
            `GITHUB_TOKEN=${input.githubToken}`,
            "-e",
            `ANTHROPIC_API_KEY=${input.anthropicApiKey}`,
            "-e",
            `ISSUE_URL=${input.issueUrl}`,
            input.workerImage
        ];
        log("info", "local_docker.start", { correlationId: input.correlationId, image: input.workerImage });
        const child = this.spawnFn("docker", args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env
        });
        child.stdout?.on("data", (buf) => log("info", "local_docker.stdout", { correlationId: input.correlationId, line: String(buf).trimEnd() }));
        child.stderr?.on("data", (buf) => log("warn", "local_docker.stderr", { correlationId: input.correlationId, line: String(buf).trimEnd() }));
        const exitCode = await new Promise((resolve, reject) => {
            child.on("error", reject);
            child.on("close", (code) => resolve(code ?? 0));
        });
        if (exitCode !== 0) {
            throw new Error(`Local Docker worker failed (exit ${exitCode})`);
        }
        log("info", "local_docker.done", { correlationId: input.correlationId });
        return { runner: "local-docker" };
    }
}
//# sourceMappingURL=local-docker.js.map
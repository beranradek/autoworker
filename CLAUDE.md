# CLAUDE.md

This file provides guidance to agent when working with code in this repository.

## Commands

```bash
pnpm build          # compile TypeScript → dist/
pnpm test           # run all tests (vitest)
pnpm typecheck      # type-check including test files
pnpm dev            # run-once (single orchestration cycle)
pnpm start          # poll loop

# Run a single test file
pnpm test test/orchestrate.test.ts

# Build the worker Docker image
DOCKER_CONFIG=/tmp/codex-docker-config docker build -t autoworker-worker:local -f docker/worker.Dockerfile .
```

Always run `pnpm build` before `pnpm start` — the CLI runs compiled JS from `dist/`.

## Architecture

Two separate runtime boundaries:

**Orchestrator** (`src/`) — a Node.js/TypeScript process that watches GitHub issues and dispatches workers. Entry point: `src/cli.ts` with four sub-commands: `run-once`, `poll`, `serve`, `cleanup`. All config is validated at startup by `src/config.ts` (Zod schema).

**Worker** (`docker/`) — an ephemeral container (Docker or ACA Job) running plain `.mjs` scripts. Entry point: `docker/worker-harness.mjs`, dispatched with env vars only (no GitHub credentials flow into OpenCode itself). The harness handles all GitHub operations.

### Orchestrator data flow

`runOrchestration` (`src/runner/orchestrate.ts`) drives a three-step label-based state machine per repo:

1. **STEP_IMPLEMENTATION** — finds open issues mentioning `WORKER_MENTION`, labels them `in-progress`, spawns a worker via `JobRunner.runIssue()`.
2. **STEP_PR_REVIEW** — finds `pr-created` issues, labels them `in-review`, spawns a worker via `JobRunner.runPrReview()`.
3. **STEP_PR_MERGE** — finds `pr-reviewed` issues (excluding `human-needed`) and auto-merges the linked PR.

Issue state is entirely driven by GitHub labels. The `IssueState` type (`src/issues/model.ts`) maps to label sets resolved in `GitHubIssueService` (`src/issues/github-service.ts`).

The orchestrator runs in two modes:
- **`poll`** — periodic loop gated by work-hours window (`WORK_HOURS_START`/`WORK_HOURS_END`).
- **`serve`** — always-on; receives GitHub webhooks via `POST /webhook` (HMAC-verified), feeds a per-process FIFO queue, and also keeps the safety-net poll running. Webhooks bypass the work-hours gate. Both share a `Mutex` so orchestration runs never overlap.

### Worker container flow

`docker/lib/implement.mjs` clones the repo, runs OpenCode (the implementer agent), optionally runs an evaluator loop (`docker/lib/evaluate.mjs`) against `## Acceptance Criteria` in the issue body, then commits/pushes/opens a PR.

`docker/lib/review.mjs` runs a single OpenCode session to review a PR and posts the result as a GitHub comment.

### JobRunner abstraction

`src/job-runner/types.ts` defines the `JobRunner` interface with two methods: `runIssue` and `runPrReview`. Two implementations exist:
- `local-docker` (`src/job-runner/local-docker.ts`) — `docker run` locally.
- `aca` (`src/job-runner/aca.ts`) — creates/starts Azure Container Apps Jobs.

### Key conventions

- All structured log output goes through `log(level, event, fields)` (`src/log.ts`).
- Label rollback on worker launch failure: if `transitionTo(issue, "in_progress")` succeeds but `runner.runIssue()` throws, the orchestrator calls `unmarkInProgress()` to avoid stranding the issue.
- The orchestrator never passes GitHub credentials into OpenCode; only the worker harness holds and uses `GH_TOKEN`.
- `LLM_MODEL` prefix (`openai/`, `anthropic/`, `azure/`) selects the provider inside the worker.

# autoworker (PoC)

Polls GitHub issues in one repo and, when an issue contains `@worker`, claims it and runs an ephemeral AI worker (OpenCode CLI) that implements the issue and posts a PR link back to the issue.

Supported runners:

- `JOB_RUNNER=local-docker` (default): runs the worker container locally via Docker
- `JOB_RUNNER=aca`: creates + starts per-issue Azure Container Apps Jobs

## Workflow

1. Find issues that mention `WORKER_MENTION` (default `@worker`)
2. Skip anything already labeled `accepted` / `in-progress` / `done`
3. Add `accepted` label + comment with correlation id
4. If `DRY_RUN=false`, start the worker container/job
5. Worker runs OpenCode to edit files; then the worker harness deterministically commits/pushes/creates PR and comments the PR link back to the issue

## Local run (poller)

```bash
pnpm install
pnpm build
cp .env.example .env
pnpm start
```

Background helper (PID + logs in `.run/`):

```bash
./scripts/poller.sh start
./scripts/poller.sh logs
./scripts/poller.sh stop
```

## Worker image (OpenCode)

```bash
DOCKER_CONFIG=/tmp/codex-docker-config docker build -t autoworker-opencode-agent:local -f docker/worker.Dockerfile .
```

## Env vars

Minimum (local):

- `GITHUB_OWNER`, `GITHUB_REPO`
- `GITHUB_TOKEN` (or `GH_TOKEN`)
- `DRY_RUN` (`true` = claim-only, `false` = also runs the worker)

When `DRY_RUN=false`:

- `WORKER_IMAGE` (e.g. `autoworker-opencode-agent:local`)
- `OPENAI_API_KEY`
- `LLM_MODEL` (optional, default `openai/gpt-5-mini`)

Optional:

- `POLL_INTERVAL_SECONDS` (default `60`)
- `MAX_ACCEPT_PER_RUN` (default `1`)
- `JOB_RUNNER` (`local-docker` or `aca`)

Azure runner (`JOB_RUNNER=aca`) additionally requires:

- `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_LOCATION`, `ACA_ENV_NAME`
- Auth: either `AZURE_USE_MANAGED_IDENTITY=true` or service principal (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`)

## Azure setup (Terraform)

See `terraform/README.md`.

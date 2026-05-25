# Autoworker

Polls GitHub issues across one or more repos and, when an issue contains `@worker`, claims it and runs an ephemeral AI worker container (OpenCode CLI with harness) that implements the issue and posts a PR link back to the issue.

Supported runners:

- `JOB_RUNNER=local-docker` (default): runs the worker containers locally from main Node.js server via Docker
- `JOB_RUNNER=aca`: creates + starts remote per-issue Azure Container Apps Jobs from main Node.js server

## Workflow

1. Find issues that mention `WORKER_MENTION` (default `@worker`)
2. Skip anything already labeled `accepted` / `in-progress` / `done`
3. Add `accepted` label + comment with correlation id
4. If `DRY_RUN=false`, start the worker container/job
5. Worker runs OpenCode to edit files; then the worker harness deterministically commits/pushes/creates PR and comments the PR link back to the issue

Security note: OpenCode runs without GitHub token env vars (and with a minimal allowlist of env vars); only the harness performs GitHub operations.

## Local run (poller)

```bash
pnpm install
pnpm build
cp .env.example .env
pnpm start
```

Background helper (PID + logs in `.run/`):

```bash
./poller.sh start
./poller.sh logs
./poller.sh stop
```

## Worker image (OpenCode)

```bash
DOCKER_CONFIG=/tmp/codex-docker-config docker build -t autoworker-worker:local -f docker/worker.Dockerfile .
```

## Env vars

Minimum (local):

- `GITHUB_REPOS` (comma/whitespace-separated `owner/repo` list; can contain a single entry)
- `GITHUB_TOKEN` (or `GH_TOKEN`)
- `DRY_RUN` (`true` = claim-only, `false` = also runs the worker)

When `DRY_RUN=false`:

- `WORKER_IMAGE` (e.g. `autoworker-worker:local`)
- `OPENAI_API_KEY`
- `LLM_MODEL` (optional, default `openai/gpt-5-mini`)

Optional:

- `POLL_INTERVAL_SECONDS` (default `60`)
- `MAX_ACCEPT_PER_RUN` (default `1`)
- `MAX_CONCURRENT_WORKERS` (default `5`)
- `JOB_RUNNER` (`local-docker` or `aca`)

Azure runner (`JOB_RUNNER=aca`) additionally requires:

- `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_LOCATION`, `ACA_ENV_NAME`
- Auth: either `AZURE_USE_MANAGED_IDENTITY=true` or service principal (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`)

## Azure setup (Terraform)

See `terraform/README.md`.

Both polling server and workers run as Azure Container Apps Jobs.
Poller runs based on cron expression schedule set in Terraform..

Minimum variables needed (everything else has defaults):

```bash
export TF_VAR_subscription_id="<your-subscription-id>"
export TF_VAR_resource_group_name="autoworker-rg"
export TF_VAR_location="germanywestcentral"
export TF_VAR_github_repos="myorg/myrepo"
terraform apply
```

Secrets (`GITHUB_TOKEN`, `OPENAI_API_KEY`) are set directly in Key Vault after apply — never in Terraform vars or tfstate.

### Useful Azure commands

Runs of main poller application and their states:

`az containerapp job execution list --name autoworker-poller --resource-group autoworker-rg --output table`

Logs of concrete run:

`az containerapp job logs show --name autoworker-poller --resource-group autoworker-rg --execution <execution-name> --container autoworker-server --tail 50`

Logs from all runs:

`az containerapp job logs show --name autoworker-poller --resource-group autoworker-rg --container autoworker-server --tail 200`

Manual execution of poller job:

`az containerapp job start --name autoworker-poller --resource-group autoworker-rg`

To update the env var on the job:
`az containerapp job update --name autoworker-poller --resource-group autoworker-rg --set-env-vars "GITHUB_REPOS=beranradek/autoworker"`

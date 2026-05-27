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
- One LLM credential — either a provider API key or a Claude subscription (the `LLM_MODEL` prefix selects the provider):
  - `OPENAI_API_KEY` for `openai/...` models
  - `ANTHROPIC_API_KEY` for `anthropic/...` models
  - `AZURE_API_KEY` + `AZURE_RESOURCE_NAME` for `azure/<deployment>` models (deployment name must match the model name)
  - `OPENCODE_AUTH_JSON` to use a monthly Claude subscription (Pro/Max) instead of an API key — see "Claude subscription" below
- `LLM_MODEL` (optional, default `openai/gpt-5-mini`)

## Claude subscription (monthly plan, no API key)

Instead of a per-token API key, the worker can authenticate OpenCode with a
monthly Claude subscription via OAuth. OpenCode stores the OAuth credentials in
`~/.local/share/opencode/auth.json`; the worker injects that file's contents
through the `OPENCODE_AUTH_JSON` env var (carried as a secret in ACA / Key
Vault), and the harness writes it back to disk before launching OpenCode.

Set it up with the helper:

```bash
# 1. Log in once (interactive OAuth — pick Anthropic / your subscription)
scripts/opencode-auth.sh login

# 2a. Local runs: write OPENCODE_AUTH_JSON into .env
scripts/opencode-auth.sh export-local .env

# 2b. Azure (ACA): push to Key Vault as the `opencode-auth-json` secret
scripts/opencode-auth.sh push-azure <key-vault-name>
```

Use an `anthropic/` model, e.g. `LLM_MODEL=anthropic/claude-opus-4-7`. For
Azure, set `use_claude_subscription = true` (and an `anthropic/` `llm_model`) so
Terraform wires the `opencode-auth-json` secret instead of a provider key.

### Token lifetime & refresh

`auth.json` holds two tokens (`{ "anthropic": { "type": "oauth", "access", "refresh", "expires" } }`):

- **access token** — short-lived (~1 hour). OpenCode refreshes it automatically on API calls when `expires` has passed, using the refresh token.
- **refresh token** — long-lived (weeks) but **rotates**: every refresh issues a new refresh token and invalidates the old one.

Rotation is the catch for ephemeral workers: when a worker refreshes, the new refresh token dies with the container, so the copy in Key Vault / `.env` becomes stale. As long as the injected access token outlives the (short) job, OpenCode never refreshes and the stored token stays valid — so in practice you only re-login when the refresh token is invalidated (long inactivity, a usage-limit reset, Anthropic revocation, or a worker that did refresh).

To stay current without a full browser re-login, refresh and re-push from the machine where you stay logged in:

```bash
scripts/opencode-auth.sh refresh                 # rotate tokens in local auth.json
scripts/opencode-auth.sh push-azure <vault>      # (or export-local) push the fresh tokens
```

A `refresh` calls Anthropic's OAuth token endpoint (`grant_type=refresh_token`) and writes the rotated tokens back to `auth.json`; pairing it with `push-azure` keeps Key Vault holding a freshly-minted token so the next worker starts with a full access-token window. You can run this on a schedule (e.g. via `/loop` or cron) to avoid manual re-logins.

> **Caveat:** Claude Pro/Max OAuth is intended for official Anthropic clients; using it from OpenCode is a community workaround that Anthropic may restrict at any time. For fully sanctioned headless automation, prefer a metered `ANTHROPIC_API_KEY` instead.

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

Secrets (`GITHUB_TOKEN` plus the provider key for the selected `llm_model` — `openai-api-key`, `anthropic-api-key`, or `azure-api-key`) are set directly in Key Vault after apply — never in Terraform vars or tfstate. For `azure/<deployment>` models also set `azure_resource_name` in `terraform.tfvars`. See the `secret_setup_commands` output for the exact commands.

To use a Claude subscription instead of a provider key, set `use_claude_subscription = true` with an `anthropic/` `llm_model`, then push credentials with `scripts/opencode-auth.sh push-azure <key-vault-name>` (the `opencode-auth-json` secret). See "Claude subscription" above.

### Useful Azure commands

#### Main poller app

Runs and their states:

`az containerapp job execution list --name autoworker-poller --resource-group autoworker-rg --output table`

Logs of concrete run:

`az containerapp job logs show --name autoworker-poller --resource-group autoworker-rg --execution <execution-name> --container autoworker-server --tail 50`

Logs from all runs:

`az containerapp job logs show --name autoworker-poller --resource-group autoworker-rg --container autoworker-server --tail 200`
`az containerapp job logs show --name autoworker-poller --resource-group autoworker-rg --container autoworker-server --follow`

Manual execution of one poll run:

`az containerapp job start --name autoworker-poller --resource-group autoworker-rg`

To update the env var on the job:
`az containerapp job update --name autoworker-poller --resource-group autoworker-rg --set-env-vars "GITHUB_REPOS=beranradek/autoworker"`

#### Worker Azure Container Apps Job (per issue)

The worker is not a static Container App — it's dynamically created as an ACA Job per issue with the prefix issue-agent.

List recent worker job executions:

`az containerapp job list --resource-group autoworker-rg --query "[?starts_with(name, 'issue-agent')].{name:name, created:systemData.createdAt}" -o table`

View logs for a specific worker job:

`az containerapp job logs show --name <issue-agent-XXXXX> --resource-group autoworker-rg --tail 200`

For real-time streaming, use Log Analytics (if configured):

`az monitor log-analytics query --workspace <workspace-id> --analytics-query "ContainerAppConsoleLogs_CL | where ContainerName_s startswith 'issue-agent' | order by TimeGenerated desc | limit 100" --resource-group autoworker-rg --tail 200`

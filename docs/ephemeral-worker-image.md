# Ephemeral AI worker image (OpenCode / `opencode`) — used by autoworker

This repo contains the Docker image used for unattended per-issue runs.

Location: `docker/`

This directory contains:

- `docker/worker.Dockerfile` (primary): OpenCode (`opencode`) worker; the LLM provider is selected by the `LLM_MODEL` prefix (`openai/`, `anthropic/`, `azure/`)

## Build locally

```bash
cd dev/autoworker
DOCKER_CONFIG=/tmp/codex-docker-config docker build -t autoworker-worker:local -f docker/worker.Dockerfile .
```

## Smoke test

```bash
docker run --rm -it autoworker-worker:local bash -lc 'whoami && opencode --version && node -v && java -version && gradle -v && gh --version && rg --version && python3 --version && chromium --version'
```

## Runtime inputs (env vars)

- One LLM provider key, matching the `LLM_MODEL` prefix (required):
  - `OPENAI_API_KEY` for `openai/...`
  - `ANTHROPIC_API_KEY` for `anthropic/...`
  - `AZURE_API_KEY` + `AZURE_RESOURCE_NAME` for `azure/<deployment>` (deployment name must match the model name)
- `GH_TOKEN` or `GITHUB_TOKEN` (required for cloning + PR/comment)
- `ISSUE_URL` (recommended) or (`ISSUE_REPO` + `ISSUE_NUMBER`) or `ISSUE_TEXT`
- `LLM_MODEL` (optional, default `openai/gpt-5-mini`)
- `VERIFY_CMD` (optional) – shell command run after OpenCode (fails the run if non-zero)

## Deterministic harness

The container entrypoint is a deterministic harness that:

1. Clones the repo (`gh repo clone`) using `GH_TOKEN`
2. Creates/resets a deterministic branch (`issue-<n>-<slug>`)
3. Runs `opencode run` **without** GitHub token env vars (so the agent can’t push/create PRs)
   - OpenCode is run with `--format json` for audit-friendly JSONL event output
   - The agent is instructed to write `.autoworker/result.json` (status + optional suggested commit/PR metadata)
   - OpenCode receives only a minimal allowlist of env vars (the selected provider key, `LLM_MODEL`, `PATH`, `HOME`, …), not the full container env
4. Detects git changes (`git status --porcelain`)
5. If changes exist, commits + pushes + creates a PR + comments the PR URL back to the issue (all deterministically via `git`/`gh`)

Artifacts are written under `/workspace/artifacts` (configurable via `ARTIFACTS_DIR`).

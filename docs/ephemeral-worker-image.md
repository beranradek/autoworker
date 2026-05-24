# Ephemeral AI worker image (OpenCode / `opencode`) — used by autoworker

This repo contains the Docker image used for unattended per-issue runs.

Location: `docker/`

This directory contains:

- `docker/worker.Dockerfile` (primary): OpenCode (`opencode`) worker using `OPENAI_API_KEY`

## Build locally

```bash
cd dev/autoworker
DOCKER_CONFIG=/tmp/codex-docker-config docker build -t autoworker-opencode-agent:local -f docker/worker.Dockerfile .
```

## Smoke test

```bash
docker run --rm -it autoworker-opencode-agent:local bash -lc 'whoami && opencode --version && node -v && java -version && gradle -v && gh --version && rg --version && python3 --version && chromium --version'
```

## Runtime inputs (env vars)

- `OPENAI_API_KEY` (required)
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
4. Detects git changes (`git status --porcelain`)
5. If changes exist, commits + pushes + creates a PR + comments the PR URL back to the issue (all deterministically via `git`/`gh`)

Artifacts are written under `/workspace/artifacts` (configurable via `ARTIFACTS_DIR`).

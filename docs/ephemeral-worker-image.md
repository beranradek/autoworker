# Ephemeral AI worker image (OpenCode / `opencode`) — used by autoworker

This repo contains the Docker image used for unattended per-issue runs.

Location: `docker/claude-agent/`

This directory contains:

- `Dockerfile` (primary): OpenCode (`opencode`) worker using `OPENAI_API_KEY`
- `Dockerfile.claude` (secondary): legacy Claude Code worker using `ANTHROPIC_API_KEY`

## Build locally

```bash
cd dev/autoworker
DOCKER_CONFIG=/tmp/codex-docker-config docker build -t autoworker-opencode-agent:local -f docker/claude-agent/Dockerfile docker/claude-agent
```

## Smoke test

```bash
docker run --rm -it autoworker-opencode-agent:local bash -lc 'whoami && opencode --version && node -v && java -version && gradle -v && gh --version && rg --version && python3 --version && chromium --version'
```

## Runtime inputs (env vars)

- `OPENAI_API_KEY` (required)
- `GH_TOKEN` or `GITHUB_TOKEN` (required for cloning + PR/comment)
- `ISSUE_URL` (recommended) or (`ISSUE_REPO` + `ISSUE_NUMBER`) or `ISSUE_TEXT`
- `OPENCODE_MODEL` (optional, default `gpt-5-mini`)

#!/usr/bin/env bash
set -euo pipefail

log() { printf '%s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }

if [[ "${1:-}" == "bash" || "${1:-}" == "sh" || "${1:-}" == "/bin/bash" || "${1:-}" == "/bin/sh" ]]; then
  exec "$@"
fi

export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

: "${ANTHROPIC_API_KEY:=}"
[[ -n "$ANTHROPIC_API_KEY" ]] || die "ANTHROPIC_API_KEY is required for headless Claude Code runs"

WORKDIR="${WORKDIR:-/workspace}"
CLONE_DIR="${CLONE_DIR:-$WORKDIR/repo}"

ISSUE_URL="${ISSUE_URL:-}"
ISSUE_REPO="${ISSUE_REPO:-${GITHUB_REPOSITORY:-}}"
ISSUE_NUMBER="${ISSUE_NUMBER:-}"
ISSUE_TEXT="${ISSUE_TEXT:-}"
ISSUE_FILE="${ISSUE_FILE:-}"

if [[ -n "$ISSUE_FILE" ]]; then
  [[ -f "$ISSUE_FILE" ]] || die "ISSUE_FILE not found: $ISSUE_FILE"
  ISSUE_TEXT="$(cat "$ISSUE_FILE")"
fi

owner_repo=""
issue_num=""
if [[ -n "$ISSUE_URL" ]]; then
  if [[ "$ISSUE_URL" =~ ^https://github\.com/([^/]+)/([^/]+)/issues/([0-9]+) ]]; then
    owner_repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    issue_num="${BASH_REMATCH[3]}"
  else
    die "Unsupported ISSUE_URL format (expected https://github.com/<owner>/<repo>/issues/<n>): $ISSUE_URL"
  fi
elif [[ -n "$ISSUE_REPO" && -n "$ISSUE_NUMBER" ]]; then
  owner_repo="$ISSUE_REPO"
  issue_num="$ISSUE_NUMBER"
elif [[ -n "$ISSUE_TEXT" ]]; then
  owner_repo="${ISSUE_REPO:-}"
else
  die "Provide one of: ISSUE_URL, (ISSUE_REPO + ISSUE_NUMBER), ISSUE_TEXT, or ISSUE_FILE"
fi

mkdir -p "$WORKDIR"

if [[ -n "$owner_repo" && ! -d "$CLONE_DIR/.git" ]]; then
  if [[ -z "$GH_TOKEN" ]]; then
    die "GH_TOKEN (or GITHUB_TOKEN) is required to clone $owner_repo via gh"
  fi
  log "Cloning repo $owner_repo -> $CLONE_DIR"
  rm -rf "$CLONE_DIR" 2>/dev/null || true
  gh repo clone "$owner_repo" "$CLONE_DIR"
fi

if [[ -d "$CLONE_DIR/.git" ]]; then
  cd "$CLONE_DIR"
else
  cd "$WORKDIR"
fi

issue_title=""
issue_body=""
issue_url="$ISSUE_URL"

if [[ -n "$owner_repo" && -n "$issue_num" ]]; then
  if [[ -z "$GH_TOKEN" ]]; then
    die "GH_TOKEN (or GITHUB_TOKEN) is required to fetch issue metadata for $owner_repo#$issue_num"
  fi
  log "Fetching issue $owner_repo#$issue_num"
  issue_json="$(gh issue view "$issue_num" --repo "$owner_repo" --json title,body,url,number 2>/dev/null || true)"
  [[ -n "$issue_json" ]] || die "Failed to fetch issue via gh (check GH_TOKEN permissions)"
  issue_title="$(jq -r '.title // ""' <<<"$issue_json")"
  issue_body="$(jq -r '.body // ""' <<<"$issue_json")"
  issue_url="$(jq -r '.url // ""' <<<"$issue_json")"
  [[ -n "$issue_url" ]] || issue_url="$ISSUE_URL"
fi

if [[ -n "$ISSUE_TEXT" && -z "$issue_body" ]]; then
  issue_body="$ISSUE_TEXT"
fi

prompt_file="$(mktemp /tmp/issue-prompt.XXXXXX.txt)"
cat >"$prompt_file" <<EOF
You are running inside an ephemeral Docker container with a checked-out repository.

Task: resolve the GitHub issue below. Make the smallest correct change that fixes it.

If a code change is needed:
1) Create a new branch (e.g. issue-${issue_num:-manual})
2) Implement the fix
3) Run the project's fastest relevant checks (unit tests/lint/typecheck/build if available)
4) Commit changes with a clear message
5) Push the branch to origin (requires GH_TOKEN)
6) Open a PR referencing the issue (requires GH_TOKEN)
7) Comment the PR link back to the issue (requires GH_TOKEN)

Issue:
repo: ${owner_repo:-<not-provided>}
url: ${issue_url:-<not-provided>}
title: ${issue_title:-<not-provided>}

body:
${issue_body:-<empty>}
EOF

CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-bypassPermissions}"
CLAUDE_EXTRA_ARGS="${CLAUDE_EXTRA_ARGS:-}"

log "Starting Claude Code CLI"
set -x
claude --bare \
  --permission-mode "$CLAUDE_PERMISSION_MODE" \
  --dangerously-skip-permissions \
  -p "$(cat "$prompt_file")" \
  --allowedTools "Bash(git *),Bash(pnpm *),Bash(npm *),Bash(node *),Bash(tsc *),Bash(gradle *),Bash(java *),Bash(jq *),Bash(rg *),Bash(gh *)" \
  $CLAUDE_EXTRA_ARGS


# Legacy wrapper preserved for reference / fallback.
#!/usr/bin/env bash
set -euo pipefail

log() { printf '%s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }

if [[ "${1:-}" == "bash" || "${1:-}" == "sh" || "${1:-}" == "/bin/bash" || "${1:-}" == "/bin/sh" ]]; then
  exec "$@"
fi

export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

: "${ANTHROPIC_API_KEY:=}"
[[ -n "$ANTHROPIC_API_KEY" ]] || die "ANTHROPIC_API_KEY is required for Claude Code"

WORKDIR="${WORKDIR:-/workspace}"
CLONE_DIR="${CLONE_DIR:-$WORKDIR/repo}"

ISSUE_URL="${ISSUE_URL:-}"
ISSUE_REPO="${ISSUE_REPO:-${GITHUB_REPOSITORY:-}}"
ISSUE_NUMBER="${ISSUE_NUMBER:-}"

if [[ -z "$ISSUE_URL" ]]; then
  die "ISSUE_URL is required"
fi

if [[ "$ISSUE_URL" =~ ^https://github\.com/([^/]+)/([^/]+)/issues/([0-9]+) ]]; then
  owner_repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  issue_num="${BASH_REMATCH[3]}"
else
  die "Unsupported ISSUE_URL: $ISSUE_URL"
fi

mkdir -p "$WORKDIR"
rm -rf "$CLONE_DIR" 2>/dev/null || true
gh repo clone "$owner_repo" "$CLONE_DIR"
cd "$CLONE_DIR"

issue_json="$(gh issue view "$issue_num" --repo "$owner_repo" --json title,body,url,number)"
issue_title="$(jq -r '.title // \"\"' <<<"$issue_json")"
issue_body="$(jq -r '.body // \"\"' <<<"$issue_json")"
issue_url="$(jq -r '.url // \"\"' <<<"$issue_json")"

prompt_file="$(mktemp /tmp/issue-prompt.XXXXXX.txt)"
cat >"$prompt_file" <<EOF
Fix this issue and open a PR:
${issue_url}

Title: ${issue_title}

Body:
${issue_body}
EOF

claude --bare --dangerously-skip-permissions -p "$(cat "$prompt_file")"


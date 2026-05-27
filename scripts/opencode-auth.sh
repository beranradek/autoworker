#!/usr/bin/env bash
#
# Helper for using a monthly Claude (or other provider) subscription with the
# autoworker OpenCode worker, instead of a per-token API key.
#
# OpenCode stores OAuth subscription credentials in auth.json. This script logs
# in once, then exports that file's contents so they can be injected into the
# ephemeral worker container via the OPENCODE_AUTH_JSON env var / secret:
#   - local runs:  written into .env
#   - Azure (ACA): pushed to Key Vault as the `opencode-auth-json` secret
#
# Usage:
#   scripts/opencode-auth.sh login                 # interactive OAuth login
#   scripts/opencode-auth.sh show                  # print the auth.json path
#   scripts/opencode-auth.sh refresh               # rotate tokens via the refresh token
#   scripts/opencode-auth.sh export-local [.env]   # write OPENCODE_AUTH_JSON into .env
#   scripts/opencode-auth.sh push-azure <vault>    # set Key Vault secret opencode-auth-json
#
set -euo pipefail

AUTH_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
AUTH_FILE="$AUTH_DIR/auth.json"
SECRET_NAME="opencode-auth-json"

# Anthropic OAuth (same client id OpenCode/Claude Code use for the PKCE flow).
OAUTH_CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
OAUTH_TOKEN_URL="https://console.anthropic.com/v1/oauth/token"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: required command not found: $1" >&2
    exit 1
  }
}

require_auth_file() {
  if [[ ! -f "$AUTH_FILE" ]]; then
    echo "error: $AUTH_FILE not found. Run: $0 login" >&2
    exit 1
  fi
}

# Compact auth.json to a single line so it survives env var / .env transport.
compact_auth() {
  need jq
  jq -c . "$AUTH_FILE"
}

cmd_login() {
  need opencode
  echo "Launching OpenCode login. Choose your provider (e.g. Anthropic) and"
  echo "complete the OAuth flow in the browser to use your subscription."
  opencode auth login
  if [[ -f "$AUTH_FILE" ]]; then
    echo "Stored credentials at: $AUTH_FILE"
    echo "Providers: $(compact_auth | jq -r 'keys | join(", ")')"
  else
    echo "warning: expected $AUTH_FILE was not created" >&2
  fi
}

cmd_show() {
  require_auth_file
  echo "$AUTH_FILE"
}

cmd_export_local() {
  require_auth_file
  local env_file="${1:-.env}"
  local value
  value="$(compact_auth)"
  touch "$env_file"
  # Drop any existing line, then append the fresh one.
  local tmp
  tmp="$(mktemp)"
  grep -v '^OPENCODE_AUTH_JSON=' "$env_file" > "$tmp" || true
  printf 'OPENCODE_AUTH_JSON=%s\n' "$value" >> "$tmp"
  mv "$tmp" "$env_file"
  chmod 600 "$env_file" 2>/dev/null || true
  echo "Wrote OPENCODE_AUTH_JSON into $env_file"
}

# Exchange the stored refresh token for a fresh access+refresh token and write
# the rotated pair back to auth.json. Anthropic rotates refresh tokens, so the
# old refresh token is invalid after this succeeds.
cmd_refresh() {
  need jq
  need curl
  require_auth_file
  local refresh
  refresh="$(jq -r '.anthropic.refresh // empty' "$AUTH_FILE")"
  if [[ -z "$refresh" ]]; then
    echo "error: no anthropic.refresh token in $AUTH_FILE. Run: $0 login" >&2
    exit 1
  fi

  local resp
  resp="$(curl -sS -X POST "$OAUTH_TOKEN_URL" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg rt "$refresh" --arg cid "$OAUTH_CLIENT_ID" \
      '{grant_type:"refresh_token", refresh_token:$rt, client_id:$cid}')")"

  if [[ "$(jq -r 'has("access_token")' <<<"$resp")" != "true" ]]; then
    echo "error: refresh failed (token may be revoked or expired). Run: $0 login" >&2
    echo "$resp" | jq -r '.error_description // .error // .' >&2 || true
    exit 1
  fi

  local now_ms expires
  now_ms="$(( $(date +%s) * 1000 ))"
  expires="$(jq -r --argjson now "$now_ms" '($now + (.expires_in * 1000))' <<<"$resp")"

  local tmp
  tmp="$(mktemp)"
  jq --argjson r "$resp" --argjson exp "$expires" \
    '.anthropic = (.anthropic // {}) + {type:"oauth", access:$r.access_token, refresh:$r.refresh_token, expires:$exp}' \
    "$AUTH_FILE" > "$tmp"
  mv "$tmp" "$AUTH_FILE"
  chmod 600 "$AUTH_FILE" 2>/dev/null || true
  echo "Refreshed anthropic OAuth tokens in $AUTH_FILE"
}

cmd_push_azure() {
  need az
  require_auth_file
  local vault="${1:-}"
  if [[ -z "$vault" ]]; then
    echo "error: vault name required. Usage: $0 push-azure <vault>" >&2
    exit 1
  fi
  az keyvault secret set \
    --vault-name "$vault" \
    --name "$SECRET_NAME" \
    --value "$(compact_auth)" \
    --output none
  echo "Set Key Vault secret '$SECRET_NAME' in vault '$vault'."
  echo "Set TF_VAR_use_claude_subscription=true (and an anthropic/ llm_model) to wire it into the poller."
}

main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    login) cmd_login "$@" ;;
    show) cmd_show "$@" ;;
    refresh) cmd_refresh "$@" ;;
    export-local) cmd_export_local "$@" ;;
    push-azure) cmd_push_azure "$@" ;;
    *)
      echo "Usage: $0 {login|show|refresh|export-local [.env]|push-azure <vault>}" >&2
      exit 2
      ;;
  esac
}

main "$@"

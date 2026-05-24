#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "bash" || "${1:-}" == "sh" || "${1:-}" == "/bin/bash" || "${1:-}" == "/bin/sh" ]]; then
  exec "$@"
fi

exec node /usr/local/lib/autoworker/worker-harness.mjs

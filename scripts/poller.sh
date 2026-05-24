#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RUNDIR="${RUNDIR:-$PROJECT_DIR/.run}"
PIDFILE="$RUNDIR/poller.pid"
LOGFILE="${LOGFILE:-$RUNDIR/poller.log}"

mkdir -p "$RUNDIR"

is_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

cmd="${1:-}"
shift || true

case "$cmd" in
  start)
    if [[ -f "$PIDFILE" ]]; then
      pid="$(cat "$PIDFILE" 2>/dev/null || true)"
      if [[ -n "${pid:-}" ]] && is_alive "$pid"; then
        echo "Already running (pid $pid)"
        exit 0
      fi
      rm -f "$PIDFILE" || true
    fi

    cd "$PROJECT_DIR"
    pnpm -s build

    # Detach from the current shell so the poller can keep running.
    # Note: uses the current environment (incl. GH_TOKEN/GITHUB_TOKEN if set).
    setsid -f bash -lc "cd \"$PROJECT_DIR\" && exec node --enable-source-maps dist/cli.js poll" >>"$LOGFILE" 2>&1

    # setsid -f does not reliably expose the child pid; find the newest matching process.
    pid="$(ps -eo pid,lstart,cmd | rg -n --fixed-strings -- 'node --enable-source-maps dist/cli.js poll' | tail -n 1 | awk '{print $1}' || true)"
    if [[ -z "${pid:-}" ]]; then
      echo "Failed to start poller. See log: $LOGFILE"
      exit 1
    fi

    echo "$pid" > "$PIDFILE"
    echo "Started (pid $pid)"
    echo "Log: $LOGFILE"
    ;;

  stop)
    if [[ ! -f "$PIDFILE" ]]; then
      echo "Not running (no pidfile)."
      exit 0
    fi
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [[ -z "${pid:-}" ]]; then
      rm -f "$PIDFILE" || true
      echo "Not running (empty pidfile)."
      exit 0
    fi
    if is_alive "$pid"; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 30); do
        is_alive "$pid" || break
        sleep 0.2
      done
      if is_alive "$pid"; then
        kill -9 "$pid" 2>/dev/null || true
      fi
      echo "Stopped (pid $pid)"
    else
      echo "Not running (stale pid $pid)."
    fi
    rm -f "$PIDFILE" || true
    ;;

  status)
    if [[ -f "$PIDFILE" ]]; then
      pid="$(cat "$PIDFILE" 2>/dev/null || true)"
      if [[ -n "${pid:-}" ]] && is_alive "$pid"; then
        echo "Running (pid $pid)"
        exit 0
      fi
      echo "Not running (stale pidfile)."
      exit 1
    fi
    echo "Not running."
    exit 1
    ;;

  logs)
    tail -n 200 "$LOGFILE"
    ;;

  *)
    echo "Usage: $0 <start|stop|status|logs>"
    exit 2
    ;;
esac

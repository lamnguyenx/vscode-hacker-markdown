#!/usr/bin/env bash
# Gracefully kill the dev host bound to a CDP port.
#
#   tools/kill-devhost.sh [port]
#
# Sends SIGTERM to the MAIN dev-host process only (VS Code handles SIGTERM by
# shutting down cleanly, which closes its renderer helpers with it). Killing
# the main process and its "Code Helper (Renderer)" processes simultaneously —
# which a plain `pkill -f "remote-debugging-port=$PORT"` does, because the
# helpers carry the same flag in their args — looks like a crash, and macOS /
# VS Code then pops the "Closed … Reopen?" dialog.
#
# Waits for the CDP port to free (graceful exit), then SIGKILLs as a last
# resort after 15s.
set -u

PORT="${1:-9335}"

# Main process only: exclude the "Code Helper …" processes.
MAIN_PIDS="$(pgrep -f "remote-debugging-port=$PORT" | while read -r pid; do
  if ! ps -p "$pid" -o command= 2>/dev/null | grep -q "Code Helper"; then
    echo "$pid"
  fi
done)"

if [ -z "$MAIN_PIDS" ]; then
  echo "no dev host on port $PORT"
  exit 0
fi

echo "SIGTERM to dev host main process(es): $(echo "$MAIN_PIDS" | tr '\n' ' ')"
kill -TERM $MAIN_PIDS

for _ in $(seq 1 15); do
  if ! curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "dev host on port $PORT shut down"
    exit 0
  fi
  sleep 1
done

echo "still up after 15s; SIGKILL" >&2
kill -KILL $MAIN_PIDS 2>/dev/null || true

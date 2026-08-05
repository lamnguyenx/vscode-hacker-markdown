#!/usr/bin/env bash
# Gracefully kill the dev host bound to a CDP port.
#
#   tools/kill-devhost.sh [port]
#
# Sends SIGTERM to the MAIN dev-host process only (VS Code handles SIGTERM by
# shutting down cleanly, which closes its renderer helpers with it). Killing
# the main process and its helpers simultaneously — which a plain
# `pkill -f "remote-debugging-port=$PORT"` does, because the helpers carry
# the same flag in their args — looks like a crash, and macOS / VS Code then
# pops the "Closed … Reopen?" dialog.
#
# Waits for the CDP port to free (graceful exit), then SIGKILLs as a last
# resort after 15s. On Linux, also frees the port from orphaned fd holders
# (Chromium's dconf helper survives the main process and keeps the port
# bound but unresponsive, which would block the next launch).
set -u

PORT="${1:-9335}"

# Linux only: the CDP socket dies with the main process, but a leftover
# dconf child (spawned by GLib proxy watching) may keep the listener fd
# alive — LISTEN state, but nothing accepts, so curl hangs. Kill any holder
# on the port: at this point the main process was already SIGTERMed (or
# SIGKILLed), so whatever still holds the fd is either it dying or an
# orphan — both must be gone before the next launch.
free_port_holders() {
  [ "$(uname -s)" = "Linux" ] || return 0
  command -v ss >/dev/null 2>&1 || return 0
  sleep 1
  local holder
  holder="$(ss -tlnp 2>/dev/null | grep ":$PORT " | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)"
  if [ -n "$holder" ]; then
    echo "freeing fd holder on port $PORT (pid $holder)"
    kill "$holder" 2>/dev/null || true
    sleep 1
  fi
}

# Main process only: exclude helpers. macOS helpers are named
# "Code Helper (Renderer)…"; Linux helpers carry --type=renderer/utility.
MAIN_PIDS="$(pgrep -f "remote-debugging-port=$PORT" | while read -r pid; do
  if ! ps -p "$pid" -o command= 2>/dev/null | grep -qE "Code Helper|--type="; then
    echo "$pid"
  fi
done)"

if [ -z "$MAIN_PIDS" ]; then
  echo "no dev host on port $PORT"
  free_port_holders
  exit 0
fi

echo "SIGTERM to dev host main process(es): $(echo "$MAIN_PIDS" | tr '\n' ' ')"
kill -TERM $MAIN_PIDS

for _ in $(seq 1 15); do
  if ! curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    free_port_holders
    echo "dev host on port $PORT shut down"
    exit 0
  fi
  sleep 1
done

echo "still up after 15s; SIGKILL" >&2
kill -KILL $MAIN_PIDS 2>/dev/null || true
sleep 1
free_port_holders
exit 1

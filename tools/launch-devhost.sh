#!/usr/bin/env bash
# Launch the Hacker Markdown extension dev host in the background, without
# leaving it as the macOS active window.
#
#   tools/launch-devhost.sh [--port 9335] [--profile exp/devhost] [--file tests/workspace/test.md]
#
# What it does:
#   1. Captures the currently active macOS app (`lsappinfo front`).
#   2. Kills any previous dev host bound to the same CDP port.
#   3. Launches `code` with --extensionDevelopmentPath under nohup (separate
#      instance: fresh --user-data-dir profile, pinned --remote-debugging-port).
#   4. Polls the CDP port until the window is up.
#   5. Re-activates the app captured in step 1 (`open -b` — no osascript, no
#      automation-permission prompt).
#
# The dev host is the only environment the extension runs in — see
# docs/important/how-to-test.md for the full pipeline.
set -u

PORT=9335
PROFILE="$PWD/exp/devhost"
FILE="$PWD/tests/workspace/test.md"

usage() {
  cat <<'EOF'
Usage: tools/launch-devhost.sh [--port 9335] [--profile exp/devhost] [--file tests/workspace/test.md]

Launches the extension dev host in the background on the given CDP port,
restoring the previously active macOS app after the window comes up.
EOF
  exit "${1:-0}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --file) FILE="${2:?--file needs a value}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done

case "$FILE" in
  /*) ;; # already absolute
  *) FILE="$PWD/$FILE" ;;
esac

FRONT_ASN="$(lsappinfo front)"
FRONT_BUNDLE="$(lsappinfo info -only bundleID "$FRONT_ASN" 2>/dev/null | grep -o 'com\.[^"]*' | head -1)"
FRONT_NAME="$(lsappinfo info -only name "$FRONT_ASN" 2>/dev/null | sed -n 's/.*"LSDisplayName"="\([^"]*\)".*/\1/p' | head -1)"
echo "frontmost: ${FRONT_NAME:-unknown} (${FRONT_BUNDLE:-?})"

pkill -f "remote-debugging-port=$PORT" 2>/dev/null || true
"$PWD/tools/kill-devhost.sh" "$PORT"
sleep 1

nohup code --extensionDevelopmentPath="$PWD" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --new-window "$FILE" \
  > "$PWD/exp/devhost-launch.log" 2>&1 &
disown

UP=
for _ in $(seq 1 30); do
  if curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    UP=1
    break
  fi
  sleep 1
done
if [ "$UP" != 1 ]; then
  echo "dev host did not come up on port $PORT (see exp/devhost-launch.log)" >&2
  exit 1
fi
sleep 2

if [ -n "${FRONT_BUNDLE:-}" ]; then
  open -b "$FRONT_BUNDLE"
  echo "reactivated ${FRONT_NAME:-$FRONT_BUNDLE}"
fi

echo "dev host up:"
curl -s -m 2 "http://127.0.0.1:$PORT/json/version" | head -c 60
echo

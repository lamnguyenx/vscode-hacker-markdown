#!/usr/bin/env bash
# Launch the Hacker Markdown extension dev host in the background, without
# leaving it as the active window, on macOS and Linux.
#
#   tools/launch-devhost.sh [--port 9335] [--profile exp/devhost] [--file tests/workspace/test.md] [--with-extensions]
#
# macOS (unchanged behavior):
#   1. Captures the currently active macOS app (`lsappinfo front`).
#   2. Kills any previous dev host bound to the same CDP port.
#   3. Launches `code` (the native desktop CLI) under nohup with a fresh
#      --user-data-dir profile and a pinned --remote-debugging-port.
#   4. Polls the CDP port until the window is up.
#   5. Re-activates the app captured in step 1 (`open -b` — no osascript).
#
# Linux:
#   1. Locates the NATIVE desktop VS Code binary. The `code` on PATH is
#      usually the Remote-SSH / vscode-server CLI wrapper, which cannot run a
#      dev host locally (it rejects --extensionDevelopmentPath,
#      --user-data-dir and --remote-debugging-port) — that instance is
#      explicitly skipped.
#   2. Kills any previous dev host on the port (graceful SIGTERM, including
#      orphaned fd holders: Chromium's dconf helper survives the main process
#      and keeps the CDP port bound but unresponsive).
#   3. Detaches the launch (systemd-run --user when available, else
#      setsid+nohup) and finds a reachable X display when DISPLAY is unset.
#   4. Polls the CDP port, then restores the previously active X window
#      (xdotool) so the host starts in the background.
#
# By default ALL user extensions are disabled (`--disable-extensions`): only
# the extension under development loads, plus VS Code built-ins (the built-in
# mermaid preview renders `.mermaid` blocks, so the suite passes without
# bierner.markdown-mermaid on VS Code >= 1.90). Pass `--with-extensions` to
# load the real user extensions (needed for older VS Code, where mermaid
# rendering requires bierner.markdown-mermaid; see docs/important/how-to-test.md).
set -u

PORT=9335
PROFILE="$PWD/exp/devhost"
FILE="$PWD/tests/workspace/test.md"
WITH_EXTENSIONS=0

usage() {
  cat <<'EOF'
Usage: tools/launch-devhost.sh [--port 9335] [--profile exp/devhost] [--file tests/workspace/test.md] [--with-extensions]

Launches the extension dev host in the background on the given CDP port,
restoring the previously active window after it comes up. On Linux the
native desktop VS Code binary is used (never the Remote-SSH `code` CLI).
EOF
  exit "${1:-0}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --file) FILE="${2:?--file needs a value}"; shift 2 ;;
    --with-extensions) WITH_EXTENSIONS=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done

case "$FILE" in
  /*) ;; # already absolute
  *) FILE="$PWD/$FILE" ;;
esac

mkdir -p "$PWD/exp"
LOG="$PWD/exp/devhost-launch.log"

OS="$(uname -s)"

# --- Linux: find the native desktop VS Code, not the remote-SSH CLI --------
is_native_code() {
  local bin="$1" real
  real="$(readlink -f "$bin" 2>/dev/null || echo "$bin")"
  case "$real" in
    */.vscode-server/*|*/.vscode-remote/*) return 1 ;;
  esac
  # desktop builds ship resources/app/product.json next to the binary;
  # the remote CLI wrapper does not.
  [ -f "$(dirname "$real")/resources/app/product.json" ]
}

find_native_code() {
  local c
  if [ -n "${HACKER_MD_CODE:-}" ] && is_native_code "$HACKER_MD_CODE"; then
    echo "$HACKER_MD_CODE"
    return 0
  fi
  for c in \
    /usr/share/code/code \
    /usr/local/bin/code \
    /usr/bin/code \
    /opt/visual-studio-code/bin/code \
    /opt/vscode/bin/code \
    /usr/bin/codium \
    /opt/vscodium/bin/codium \
    /snap/bin/code; do
    if [ -x "$c" ] && is_native_code "$c"; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

ensure_display() {
  local d sock
  if [ -n "${DISPLAY:-}" ] && (command -v xset >/dev/null 2>&1 && xset -display "$DISPLAY" q >/dev/null 2>&1 || [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ]); then
    return
  fi
  for sock in /tmp/.X11-unix/X*; do
    [ -e "$sock" ] || continue
    d=":${sock##*/X}"
    if command -v xset >/dev/null 2>&1; then
      xset -display "$d" q >/dev/null 2>&1 && { export DISPLAY="$d"; return; }
    else
      export DISPLAY="$d"
      return
    fi
  done
  echo "no reachable X display; set DISPLAY (or run under Xvfb)" >&2
  exit 1
}

case "$OS" in
  Darwin)
    CODE_BIN="code" # PATH — the native desktop CLI on macOS
    ;;
  Linux)
    CODE_BIN="$(find_native_code)" || {
      echo "no native desktop VS Code found; tried /usr/share/code, /usr/bin, /opt, /snap" >&2
      echo "set HACKER_MD_CODE=/path/to/desktop/code to override" >&2
      exit 1
    }
    ensure_display
    ;;
  *)
    echo "unsupported OS: $OS" >&2
    exit 1
    ;;
esac

# --- capture the front window (macOS: app; Linux: X window id) -------------
FRONT_BUNDLE=""
FRONT_WID=""
case "$OS" in
  Darwin)
    FRONT_ASN="$(lsappinfo front)"
    FRONT_BUNDLE="$(lsappinfo info -only bundleID "$FRONT_ASN" 2>/dev/null | grep -o 'com\.[^"]*' | head -1)"
    FRONT_NAME="$(lsappinfo info -only name "$FRONT_ASN" 2>/dev/null | sed -n 's/.*"LSDisplayName"="\([^"]*\)".*/\1/p' | head -1)"
    echo "frontmost: ${FRONT_NAME:-unknown} (${FRONT_BUNDLE:-?})"
    ;;
  Linux)
    if command -v xdotool >/dev/null 2>&1; then
      FRONT_WID="$(xdotool getactivewindow 2>/dev/null)"
    fi
    ;;
esac

# --- kill any previous dev host on the port --------------------------------
"$PWD/tools/kill-devhost.sh" "$PORT"
sleep 1

# --- launch ------------------------------------------------------------------
ARGS=(--extensionDevelopmentPath="$PWD" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --new-window)
[ "$WITH_EXTENSIONS" = 0 ] && ARGS+=(--disable-extensions)
ARGS+=("$FILE")

case "$OS" in
  Darwin)
    nohup "$CODE_BIN" "${ARGS[@]}" > "$LOG" 2>&1 &
    disown
    ;;
  Linux)
    if command -v systemd-run >/dev/null 2>&1 && [ -n "${XDG_RUNTIME_DIR:-}" ] && systemctl --user is-system-running >/dev/null 2>&1; then
      systemctl --user stop "hmk-devhost-$PORT.service" 2>/dev/null
      systemctl --user reset-failed "hmk-devhost-$PORT.service" 2>/dev/null
      systemd-run --user --unit="hmk-devhost-$PORT" --collect \
        --setenv=DISPLAY="$DISPLAY" \
        --property=StandardOutput=append:"$LOG" \
        --property=StandardError=append:"$LOG" \
        "$CODE_BIN" "${ARGS[@]}" >/dev/null 2>&1
    else
      setsid nohup "$CODE_BIN" "${ARGS[@]}" > "$LOG" 2>&1 < /dev/null &
      disown
    fi
    ;;
esac

# --- wait for the CDP port --------------------------------------------------
UP=
for _ in $(seq 1 45); do
  if curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    UP=1
    break
  fi
  sleep 1
done
if [ "$UP" != 1 ]; then
  echo "dev host did not come up on port $PORT (see $LOG)" >&2
  exit 1
fi
sleep 2

# --- restore the front window ------------------------------------------------
case "$OS" in
  Darwin)
    if [ -n "${FRONT_BUNDLE:-}" ]; then
      open -b "$FRONT_BUNDLE"
      echo "reactivated ${FRONT_NAME:-$FRONT_BUNDLE}"
    fi
    ;;
  Linux)
    if [ -n "$FRONT_WID" ]; then
      xdotool windowactivate "$FRONT_WID" 2>/dev/null || true
    fi
    ;;
esac

echo "dev host up ($CODE_BIN, port $PORT):"
curl -s -m 2 "http://127.0.0.1:$PORT/json/version" | head -c 60
echo

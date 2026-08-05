# AGENTS.md

## Project Layout

- `./exp` is the temporary directory for experiments, outputs, and scratch
  data (dev-host profiles, logs, screenshots). You may recreate it if it does
  not exist. **Do not put tracked code here.**
- `./tests` contains the test harness (`open_view.cjs`, `test_preview.cjs`,
  `cdp_eval.cjs`) and the `tests/workspace/` fixtures used by the dev host.
- `./tools` contains dev-host tooling (`launch-devhost.sh`, `kill-devhost.sh`).
- `_refs/`: references, read-only
  - `_refs/vscode` : source code of vscode for refrence only

## Testing

```bash
npm run compile
tools/launch-devhost.sh      # launches the dev host in the background and
                             # restores the previously active macOS app
node tests/open_view.cjs 9335
node tests/test_preview.cjs 9335
```

`tools/launch-devhost.sh` gracefully kills the old dev host on the port
(`tools/kill-devhost.sh`, SIGTERM to the main process only, no "Reopen?"
dialog), launches a fresh one (defaults: port 9335, `exp/devhost` profile,
`tests/workspace/test.md`, all user extensions disabled — only the dev
extension plus VS Code built-ins load), waits for the CDP port, then
re-activates the app/window that was active before the launch (macOS:
`lsappinfo` + `open -b`, Linux: `xdotool`; no osascript) — run it via
`--file`, `--profile`, `--port`, `--with-extensions` for other fixtures.

See `docs/important/how-to-test.md` for the full pipeline and gotchas.

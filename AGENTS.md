# AGENTS.md

## Project Layout

- `./exp` is the temporary directory for experiments, outputs, and scratch
  data (dev-host profiles, logs, screenshots). You may recreate it if it does
  not exist. **Do not put tracked code here.**
- `./tests` contains the test harness (`open_view.cjs`, `test_preview.cjs`,
  `cdp_eval.cjs`) and the `tests/workspace/` fixtures used by the dev host.
- The dev host is started/stopped with the `vscode_cdp` / `vscode_cdp_kill`
  shell functions from `bach_cli/bach/vscode.sh` (sourced via the bach CLI) —
  this repo no longer ships its own launch/kill scripts.
- `_refs/`: references, read-only
  - `_refs/vscode` : source code of vscode for refrence only
  - `_refs/code-server` : source code of code-server for refrence only

## Testing

```bash
npm run compile
vscode_cdp --profile "$PWD/exp/devhost" --file "$PWD/tests/workspace/test.md"
node tests/open_view.cjs 9335
node tests/test_preview.cjs 9335
```

`vscode_cdp` first gracefully kills any prior host on the same CDP port
(`vscode_cdp_kill`, SIGTERM to the main process only, no "Reopen?" dialog),
launches a fresh one (background, detached — `nohup` on macOS,
`systemd-run --user`/`setsid` on Linux), waits for the CDP port, then
returns. Defaults: port 9335, profile `~/.local/share/vscode-cdp/cdp-<port>`,
all user extensions disabled (`--disable-extensions`). For this repo, pass
`--profile "$PWD/exp/devhost"` (per-repo, carries `editor.editContext: false`
needed by the type-and-save checks) and `--file "$PWD/tests/workspace/test.md"`
(so a Markdown editor is active at startup and the preview renders
immediately). Flags: `--port`, `--profile`, `--file`, `--with-extensions`,
`--ext`, `--no-ext`, `--fg`.

Caveats vs. the previous in-repo scripts: it does NOT restore the previously
active app/window (the dev host steals focus on launch), does NOT locate the
native desktop binary on Linux (the `code` on PATH must already be the native
desktop build, not the Remote-SSH / vscode-server CLI wrapper — see
`docs/important/native-vs-remote-ssh-vscode.md`), and does NOT auto-probe X
displays on Linux (`$DISPLAY` must be set, or run under `xvfb-run`).

See `docs/important/how-to-test.md` for the full pipeline and gotchas.

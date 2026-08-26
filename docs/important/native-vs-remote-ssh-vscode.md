# Native vs Remote-SSH VS Code

When you work on this repo over Remote-SSH (or in a dev container), there are
**two different `code` executables** involved, and only one of them can run
the extension dev host.

| | Native desktop VS Code | Remote CLI wrapper (`code` on PATH) |
| --- | --- | --- |
| What it is | The real Electron app installed on the machine you SSH into (Linux: `/usr/share/code/code`, `/usr/bin/code`, `/opt/visual-studio-code/bin/code`, `/snap/bin/code`; macOS: the app's bundled `bin/code`) | A thin CLI that forwards commands to the **vscode-server** instance that serves your Remote-SSH window (`~/.vscode-server/cli/servers/<commit>/server/bin/remote-cli/code`) |
| Window | Opens real windows on the local display | Never opens a window; talks to the server over a socket |
| `--extensionDevelopmentPath` | Supported — this is how an Extension Development Host is started | Rejected: prints `Ignoring option 'extensionDevelopmentPath': not supported for code.` and continues without it |
| `--user-data-dir` / `--remote-debugging-port` / `--new-window` | Supported | Rejected (same "Ignoring option …" message) |
| What it is for | Running the dev host for this extension (see `how-to-test.md`) | Opening files, forwarding `code -d`/`-g`, installing extensions, `serve-web` |

## Why the dev host must use the native binary

The extension only exists inside an **Extension Development Host** — a desktop
VS Code window started with `--extensionDevelopmentPath=$PWD`,
`--user-data-dir=<profile>` and `--remote-debugging-port=<port>`. All three
flags are rejected by the remote CLI, so running

```sh
code --extensionDevelopmentPath="$PWD" --remote-debugging-port=9335 --new-window …
```

inside a Remote-SSH session silently degrades to a plain `code` invocation
(the flags are ignored), which is also why `vscode_cdp` against the remote
CLI fails with `VS Code CDP host did not come up on port …`.

The native binary also needs a display: it is a GUI application. On a headless
machine it exits with `Missing X server or $DISPLAY` unless run under
`xvfb-run` or with a real X server (`DISPLAY=:0` etc.).

## Extension install directories

Each host keeps its extensions in its own directory, so a Remote-SSH window
ignores `~/.vscode/extensions` on the machine you SSH'd from:

- Native desktop VS Code: `~/.vscode/extensions/`
- code-server: `${XDG_DATA_HOME:-$HOME/.local/share}/code-server/extensions/`
- Remote-SSH server (on the remote host): `~/.vscode-server/extensions/`

`vscode-hacker-meta install .` (via `make install`) installs into **every** one of these
that exists on the machine it runs on — see `how-to-install.md` §1 for when
that covers a remote host and when it cannot.

## How to tell which `code` you have

```sh
realpath "$(which code)"          # contains .vscode-server → remote CLI
code --help | grep extensionDevelopmentPath   # desktop lists it, remote CLI does not
ls "$(dirname "$(realpath "$(which code)")")/resources/app/product.json"
                                  # exists → desktop build (the remote CLI has no
                                  # resources/app next to it)
```

## How to make `vscode_cdp` find the native binary (Linux)

`vscode_cdp` runs whatever `code` is first on PATH — it does **not** probe
known native-binary locations or validate `resources/app/product.json`
(the previous in-repo `tools/launch-devhost.sh` did). Inside an
Remote-SSH / vscode-server session the `code` on PATH is usually the remote
CLI wrapper, which rejects the dev-host flags, so:

1. Before launching, confirm what `code` resolves to:
   ```sh
   realpath "$(which code)"        # contains .vscode-server → wrong CLI
   ls "$(dirname "$(realpath "$(which code)")")/resources/app/product.json"
                                   # missing → not a desktop build
   ```
2. If those fail, put the native binary first on PATH. Typical locations:
   `/usr/share/code/code`, `/usr/local/bin/code`, `/usr/bin/code`,
   `/opt/visual-studio-code/bin/code`, `/opt/vscode/bin/code`,
   `/usr/bin/codium`, `/opt/vscodium/bin/codium`, `/snap/bin/code` — any of
   them work as long as `realpath` does not land inside `.vscode-server` /
   `.vscode-remote` and `resources/app/product.json` exists next to the
   resolved binary. A shell alias in your bach profile works, as does
   symlinking the native binary into `~/.local/bin`.
3. macOS needs none of this — on macOS the `code` on PATH is already the
   native desktop CLI.

The remote CLI's per-flag rejection is silent on stderr but is visible in the
launch log; if `vscode_cdp` reports "did not come up on port …", that is the
first thing to rule out.

## Gotchas seen in practice

- **A Remote-SSH window runs the extension from `~/.vscode-server/extensions/`
  *on the remote host*** — the copy that matters is the one on the machine
  you SSH'd into, not the machine the window displays on. `make install` in
  the SSH window's integrated terminal (or `ssh <host> 'make -C <repo> install'`)
  updates it. When a window looks stale after an install:
  1. compare mtimes of the installed `out/`/`build/` against the repo's
     (installed files keep the repo's mtimes), then
  2. reload the window — extensions load at window start, so the running
     window keeps the old code until `Developer: Reload Window`.
  Observed live: the repo was fresh (new `media.css`), the dev host was green,
  but an SSH window still ran a build installed before the fix — its webview
  linked `main.css` with no `media.css`, and the media toggles changed state
  with no visual effect. The local `~/.vscode/extensions/` copy had been
  updated by `make install`; the remote `~/.vscode-server/extensions/` copy
  had not (or predated the build).
- A symlink named `code` can point at either binary; always resolve with
  `readlink -f` before judging.
- The remote CLI's error message is logged, not fatal: the first broken
  launch produces the launch log (under
  `${XDG_STATE_HOME:-$HOME/.local/state}/bach/vscode-cdp-<port>.log`)
  containing three `Ignoring option …` lines and no CDP port.
- Chromium's `dconf watch` child (GLib proxy watching) inherits the CDP
  listening socket; after the dev host exits it can keep the port in a zombie
  LISTEN state that blocks the next launch (`ss -tlnp | grep :9335`, kill the
  holder). `vscode_cdp_kill` frees it automatically — see
  `how-to-test.md` §1 (Linux notes).

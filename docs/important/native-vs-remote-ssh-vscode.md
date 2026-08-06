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
(the flags are ignored), which is also why `tools/launch-devhost.sh` failed
with `dev host did not come up on port …` before the Linux support landed.

The native binary also needs a display: it is a GUI application. On a headless
machine it exits with `Missing X server or $DISPLAY` unless run under
`xvfb-run` or with a real X server (`DISPLAY=:0` etc.).

## Extension install directories

Each host keeps its extensions in its own directory, so a Remote-SSH window
ignores `~/.vscode/extensions` on the machine you SSH'd from:

- Native desktop VS Code: `~/.vscode/extensions/`
- code-server: `${XDG_DATA_HOME:-$HOME/.local/share}/code-server/extensions/`
- Remote-SSH server (on the remote host): `~/.vscode-server/extensions/`

`tools/install.sh` (via `make install`) installs into **every** one of these
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

## How `tools/launch-devhost.sh` picks the binary (Linux)

1. `HACKER_MD_CODE=/path/to/code` overrides the search entirely.
2. Otherwise it tries, in order: `/usr/share/code/code`, `/usr/local/bin/code`,
   `/usr/bin/code`, `/opt/visual-studio-code/bin/code`, `/opt/vscode/bin/code`,
   `/usr/bin/codium`, `/opt/vscodium/bin/codium`, `/snap/bin/code`.
3. A candidate is accepted only if **both** hold:
   - `readlink -f` does not resolve into `.vscode-server` / `.vscode-remote`
     (that is the remote CLI, whatever it is named), and
   - `resources/app/product.json` exists next to the resolved binary
     (a desktop build ships its app bundle there).

macOS keeps using the plain `code` from PATH — there the PATH entry is the
native desktop CLI.

## Gotchas seen in practice

- A symlink named `code` can point at either binary; always resolve with
  `readlink -f` before judging.
- The remote CLI's error message is logged, not fatal: the first broken
  launch produces `exp/devhost-launch.log` containing three
  `Ignoring option …` lines and no CDP port.
- Chromium's `dconf watch` child (GLib proxy watching) inherits the CDP
  listening socket; after the dev host exits it can keep the port in a zombie
  LISTEN state that blocks the next launch (`ss -tlnp | grep :9335`, kill the
  holder). `tools/kill-devhost.sh` frees it automatically — see
  `how-to-test.md` §1 (Linux notes).

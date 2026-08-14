# How to Install This Extension

How to build this extension from source and load it into VS Code, and how to
keep the copy VS Code actually runs in sync with your edits. For launching the
*development host* (the separate, debug-port instance used by the test
pipeline) instead, see
[`docs/important/how-to-test.md`](how-to-test.md#1-launch-the-extension-development-host).

## 1. Build and install

```sh
npm install
make install
```

`make install` delegates to the published
[`vscode-hacker-meta`](https://www.npmjs.com/package/vscode-hacker-meta) CLI:
it packs the extension into a VSIX (`build/<publisher>.<name>-<version>.vsix`
via `vsce pack`, which runs `npm run compile` to produce `out/`, `build/`,
and `syntaxes/plantuml.tmLanguage.json`), then installs that VSIX — the path
is passed to the CLI explicitly, nothing is discovered — through every
install CLI that exists on this machine:

| Directory | Host |
| --- | --- |
| `$HOME/.vscode/extensions/` | Native desktop VS Code |
| `${XDG_DATA_HOME:-$HOME/.local/share}/code-server/extensions/` | code-server |
| `$HOME/.vscode-server/extensions/` | Remote-SSH server (when running on the remote host) |

So `make install` run in the integrated terminal of a Remote-SSH window (or
over `ssh <host>`) lands in the right place on the remote — no "Install in
SSH: <host>" round-trip needed. If you run it on the native machine while a
remote window is open, the remote only gets the copy when VS Code pushes it
(Extensions panel → *Install in SSH: …*), because a native shell cannot reach
the remote's `~/.vscode-server/extensions/`. A CLI that does not exist is
skipped; the command fails if no install CLI was found.

Each install looks like this (the VSIX is a zip with an `extension/` prefix
that VS Code strips on install):

```
$HOME/.vscode/extensions/<publisher>.<name>-<version>/
├── out/          # compiled extension host code (tsc, src/* -> out/*)
├── build/        # webview bundle + copied src/media assets (esbuild + copy)
├── syntaxes/     # vendored PlantUML TextMate grammars
├── package.json  # manifests, contributions, activation events
├── README.md
└── LICENSE
```

The install CLIs replace an existing install of the same ID (`--force`), so a
stale `out/`/`build/`/`syntaxes/` can never linger and shadow new code.
`make install` registers this repo's `tools/post_install.sh` via
`--post-install-script`, so it runs after each install and verifies the three
grammar files actually landed
(`codeblock.json`, `plantuml.tmLanguage.json`, `language-configuration.json`)
and fails loudly otherwise — a missing `syntaxes/` folder was how a "works in
the dev host, not after install" regression first slipped in.

The three runtime directories are the **complete runtime asset set**: `out/`
is the extension host code (`package.json#main`), `build/` is everything the
webview loads (`previewHost.ts` resolves its bundle + CSS as
`extensionUri/build/*`), and `syntaxes/` holds the grammars referenced by
`contributes.grammars`/`languages`. Nothing else under `src/media/` or `src/`
is read at runtime, so shipping exactly these three directories (plus the
manifests) cannot drop a needed file.

If VS Code is already running, reload the window to activate the new code:

```
Cmd+Shift+P  >  Developer: Reload Window
```

The extension activates on demand (its `activationEvents` cover
`onView:hackerMarkdown.preview`, the three commands, and `onLanguage:markdown`),
so "nothing happened after install" until you open a Markdown file / run a
command is normal.

A running window keeps the extension code it loaded at startup (extension
host code *and* the webview HTML shell — `previewHost.ts#buildHtml` runs per
webview creation). `make install` only updates the folders on disk; the
window keeps running the old copy until reload. So "I installed, why does the
window still behave like the old build?" is almost always **"the window was
not reloaded"** — or, less often, the installed copy predates the latest
build (see Troubleshooting).

### Installing a `.vsix` instead

`make vsix` produces `build/<publisher>.<name>-<version>.vsix`; install it
with `code --install-extension <vsix>` (or `code-server`, or the Remote-SSH
remote-cli — which is exactly what `make install` does for every CLI it
finds). The vsix ships the same runtime set as the folder install:

- `vscode:prepublish` is `npm run compile`, so `out/`, `build/`, and
  `syntaxes/plantuml.tmLanguage.json` are all built before packaging.
- `.vscodeignore` excludes only source/scratch (`src/`, `exp/`, `docs/`,
  `tests/`, `tools/`, `scripts/`, `_refs/`, `node_modules/`, the dev-only
  `plantuml.yaml-tmLanguage`), **not** `out/`, `build/`, or `syntaxes/`.

So `vsce pack` produces an extension with exactly the
`out build syntaxes` + `package.json`/`README.md`/`LICENSE` contents that the
installed folder has. Re-run `make vsix` after changing `src/`,
`src/webview/**`, `src/media/*`, `syntaxes/*`, or `package.json`, and keep
`.vscodeignore` in mind if a new runtime asset is ever added (it would need to
NOT be excluded, or the webview would 404).

## 2. What gets installed vs what the dev host uses

- **The dev host** (`tools/launch-devhost.sh`) runs the extension straight from
  this repository (`--extensionDevelopmentPath="$PWD"`) — it does **not** read
  the installed copy.
- **A normal VS Code window** runs the **installed** copy under
  `~/.vscode/extensions/lamnt45.vscode-hacker-markdown-0.0.1/`. If you're
  watching a normal window (not a dev host) while editing, changes in the repo
  are invisible until you re-run `make install` and reload.

## 3. Keeping the installed copy in sync

After editing **any** of these, re-run `make install` (it rebuilds first):

- `src/` (extension host)            → recompiles `out/`
- `src/webview/**` or `src/media/*`  → rebuilds `build/index.js` + `build/*.css`
- `syntaxes/*` or `package.json`     → copied as-is

Webview asset URLs are **mtime-busted** (`previewHost.ts#cacheBustBuild`), so
a *reloaded webview* always fetches the new CSS/JS — but the page only picks
them up on the next webview load. A `Refresh Preview` (which rebuilds the
webview HTML) or a window reload is required for `src/webview` / `src/media`
edits to appear. Extension-host edits (`src/*.ts`) always need the reload.

## Troubleshooting

- **`make build` dies inside `vsce` with `MODULE_NOT_FOUND`.** The npx cache
  entry for `@vscode/vsce` can end up partially installed (observed:
  `typed-rest-client/Util.js` failing to resolve a dependency). The failure
  stack is a plain `require` error inside `~/.npm/_npx/<hash>/node_modules/
  @vscode/vsce`. Fix: delete that exact cache dir (`rm -rf ~/.npm/_npx/<hash>`)
  and re-run — npx re-installs vsce fresh. Do not `npm cache clean` the whole
  store.
- **`make install` fails only on the code-server target with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'yauzl'`.** code-server's
  bundled VS Code (`…/code-server/lib/vscode`) has **no `node_modules`**:
  code-server populates it via its own `postinstall.sh` (`npm install` inside
  `lib/vscode`), and package managers that skip dependency lifecycle scripts
  (bun, pnpm `ignore-scripts` defaults) never run it — `yauzl` (VSIX
  extraction) is then missing while every other install target works.
  Repair (mirrors what the postinstall would have done):
  ```sh
  cd ~/.bun/install/global/node_modules/code-server/lib/vscode
  npm install --omit=dev --ignore-scripts --no-audit --no-fund   # JS deps incl. yauzl
  cd node_modules/node-pty && npm run install                     # prebuilt binaries (terminal)
  ```
  `--ignore-scripts` is needed because `kerberos` (a native dep) cannot
  compile on this box — it requires the system Kerberos headers
  (`gssapi/gssapi.h`, e.g. `libkrb5-dev`), and node ≥ 24 is not code-server's
  supported node 22 anyway. Kerberos only matters for Kerberos-based remote
  auth; the extension installer (yauzl) works without it.
- **Extension not loaded at all.** Check the extension folder contents
  (`make install` prints the final path) and that it's a real copy, not a
  stale one. Grep the extension-host log for the activation line:
  `grep "lamnt45.vscode-hacker-markdown" "$HOME/.vscode/.../exthost.log"` (or,
  for the dev host, `exp/devhost/logs/<ts>/window1/exthost/exthost.log`).
- **Still seeing old webview behavior after a rebuild.** The webview caches
  aggressively; confirm the served asset URL carries a new `?v=` mtime
  (check the running page's `main.css?v=…`) and that the file on disk was
  actually refreshed (compare `stat` on
  `~/.vscode/extensions/lamnt45.vscode-hacker-markdown-0.0.1/build/main.css`).
- **"Works in the dev host, but a normal window looks stale."** The dev host
  runs straight from the repo (`--extensionDevelopmentPath="$PWD"`), so it
  always shows the latest build; a normal window runs the *installed* copy,
  which reflects the repo state at the moment `make install` ran (it compiles
  first, so the copy is never older than the last install — but it can be
  older than the current repo). To pin down which build the window runs:
  1. **Check which copy the window loads.** A Remote-SSH window serves the
     extension from `~/.vscode-server/extensions/<id>/` **on the remote
     host**, not from the local `~/.vscode/extensions/` (see
     `native-vs-remote-ssh-vscode.md`). Installed files keep the repo's
     mtimes, so compare `stat -c %y` of the installed
     `out/previewHost.js`/`build/*` against the repo's.
  2. **Inspect the running webview.** The served `?v=` cache-bust values and
     the `<link>` list show whether the HTML shell came from the new build
     (observed live: a preview whose links listed `main.css?v=…` but *no*
     `media.css`, with media toggles changing state but no visual effect —
     the installed copy predated the styling fix).
  Then re-run `make install` on the machine that serves the window and reload.
- **Reloading a window from a shell.** If the window runs on another machine
  (Remote-SSH) and you cannot click it, drive `Cmd+Shift+P` →
  `Developer: Reload Window` with **trusted CDP input** on the window's `page`
  CDP target — the same `Input.dispatchKeyEvent` + palette-row click the test
  harness uses (`tests/test_preview.cjs#runPaletteCommand`). Use the
  *window's* platform modifiers (darwin `Meta`, linux `Control`) and click the
  row whose label starts with the exact command text.
- **Grammar not tokenizing.** Open editors cache tokenization — close and
  reopen the file after reinstalling. A missing grammar logs once per host in
  `renderer.log`: `grep "Unable to load and parse grammar" …/window*/renderer.log`.

For how the extension and its webview behave once it is running, see
[`docs/important/architecture.md`](architecture.md) and
[`docs/important/quirks.md`](quirks.md). Back to the
[`README`](../../README.md).

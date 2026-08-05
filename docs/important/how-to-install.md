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

`make install` runs `npm run compile` (which produces `out/`, `build/`, and
`syntaxes/plantuml.tmLanguage.json`) and then copies the extension into VS
Code's extension folder:

```
$HOME/.vscode/extensions/<publisher>.<name>-<version>/
├── out/          # compiled extension host code (tsc, src/* -> out/*)
├── build/        # webview bundle + copied src/media assets (esbuild + copy)
├── syntaxes/     # vendored PlantUML TextMate grammars
├── package.json  # manifests, contributions, activation events
└── README.md
```

The install target deliberately removes the destination first, so a stale
`out/`/`build/`/`syntaxes/` can never linger and shadow new code. After the
copy it verifies the three grammar files actually landed (`codeblock.json`,
`plantuml.tmLanguage.json`, `language-configuration.json`) and fails loudly
otherwise — a missing `syntaxes/` folder was how a "works in the dev host, not
after install" regression first slipped in.

The three copied directories are the **complete runtime asset set**: `out/` is
the extension host code (`package.json#main`), `build/` is everything the
webview loads (`previewHost.ts` resolves its bundle + CSS as
`extensionUri/build/*`), and `syntaxes/` holds the grammars referenced by
`contributes.grammars`/`languages`. Nothing else under `src/media/` or `src/`
is read at runtime, so installing exactly these four items (plus the
manifests) cannot drop a needed file.

If VS Code is already running, reload the window to activate the new code:

```
Cmd+Shift+P  >  Developer: Reload Window
```

The extension activates on demand (its `activationEvents` cover
`onView:hackerMarkdown.preview`, the three commands, and `onLanguage:markdown`),
so "nothing happened after install" until you open a Markdown file / run a
command is normal.

### Installing a `.vsix` instead

Packaging a `.vsix` ships the same runtime set and is equivalent for install
purposes — no extra wiring needed:

- `vscode:prepublish` is `npm run compile`, so `out/`, `build/`, and
  `syntaxes/plantuml.tmLanguage.json` are all built before packaging.
- `.vscodeignore` excludes only source/scratch (`src/`, `exp/`, `docs/`,
  `node_modules/`, the dev-only `plantuml.yaml-tmLanguage`), **not** `out/`,
  `build/`, or `syntaxes/`.

So `npx @vscode/vsce package` produces an extension with exactly the
`out build syntaxes` + `package.json`/`README.md` contents that `make install`
copies. Re-run `vsce package` after changing `src/`, `src/webview/**`,
`src/media/*`, `syntaxes/*`, or `package.json`, and keep `.vscodeignore` in
mind if a new runtime asset is ever added (it would need to NOT be excluded,
or the webview would 404).

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
- **Grammar not tokenizing.** Open editors cache tokenization — close and
  reopen the file after reinstalling. A missing grammar logs once per host in
  `renderer.log`: `grep "Unable to load and parse grammar" …/window*/renderer.log`.

For how the extension and its webview behave once it is running, see
[`docs/important/architecture.md`](architecture.md) and
[`docs/important/quirks.md`](quirks.md). Back to the
[`README`](../../README.md).

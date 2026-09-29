# How to Test This Extension

A webview-view extension is hard to test manually because its UI runs inside an
**out-of-process iframe (OOPIF)** (or, under code-server, a nest of same-page
iframes) that normal browser tooling (DevTools, plain Playwright) cannot reach.
There are **two environments** to test it end-to-end — **pick one before
starting**:

- **Option A — code-server in Docker (preferred).** The extension is
  symlinked into the `vscode-hacker-meta` code-server container and driven
  from a real Chromium browser on **pp** over CDP. Real user extensions,
  full interactive browser tooling, no dev host. The **environment** (ssh
  tunnels, docker compose, TLS, login, restart) is documented in
  `/home/lamnt45/git/vscode-hacker-meta/docs/important/dev-code-on-nuc-test-on-pp.md`;
  only the extension-specific parts (install, workspace URL, webview DOM
  access) are in
  [Option A: code-server in Docker](#option-a-code-server-in-docker-preferred).
- **Option B — local Extension Development Host.** A dedicated dev VS Code
  instance with a CDP port, driven by the `tests/*/*.ts` suite. Sections 1–5
  describe this pipeline:

1. Launch a dev host with a CDP port
2. Prepare the workbench: dismiss the one-time onboarding overlay, reveal the
   panel container switcher, click the "Hacker Markdown" tab
3. Reach *inside* the webview OOPIF with a raw CDP client
4. Simulate user actions (trusted CDP input only) and assert on observable state
5. Use the built-in `markdown.api.render` engine + DOM state as ground truth

**Agents: ask before testing.** Before running any test, ask the user which
environment they want (A or B); when the user has no preference, default to
**Option A (code-server)**.

For the generalized "why is the tool doing this" knowledge (scroll-event
timing, monaco virtualization, CDP keybinding flags, …), see
[`docs/important/quirks.md`](quirks.md). For how the extension is wired up
(source layout, rendering pipeline, pan/zoom frames, image `src` rewriting)
see [`docs/important/architecture.md`](architecture.md). If you work over
Remote-SSH, read [`native-vs-remote-ssh-vscode.md`](native-vs-remote-ssh-vscode.md)
first — the dev host must run the **native** desktop VS Code, not the
remote CLI `code` on PATH.

Test scripts live in [`tests/units/`](../../tests/units/), [`tests/integration/`](../../tests/integration/), [`tests/samples/`](../../tests/samples/) and [`tools/`](../../tools/):

[`tests/integration/cdp.ts`](../../tests/integration/cdp.ts) is a shared CDP
helper supporting **both** OOPIF (dev host) and nested-iframe (code-server)
topologies automatically. Connect via `connectPreview()` and use `pEval`/`pClick`
without worrying about the topology.

| Script | Purpose |
| --- | --- |
| `vscode_cdp` (from `bach_cli/bach/vscode.sh`) | Launch/restart the dev host in the background on macOS and Linux |
| `vscode_cdp_kill` (from `bach_cli/bach/vscode.sh`) | Gracefully shut down the dev host on a port (SIGTERM to the main process, so no "Closed … Reopen?" dialog; frees orphaned CDP-port fd holders on Linux) |
| `tests/integration/open_view.ts` | One-shot prep: dismiss overlay, open panel, click the view tab, wait for the OOPIF target |
| `tests/integration/test_preview.ts` | Full functional smoke test — 15 checks under code-server, 21 under dev host (eval-based checks across both; keyboard/palette tests limited under browser CDP) |
| `tests/integration/cdp_eval.ts` | Evaluate an expression in the webview OOPIF (debugging) |
| `tests/integration/rest.ts` | REST Control helper (port 47067): arrange/act via the `vscode` API — open/type/save/settings — plus `restCleanup()` used by every `*_ix.ts` suite's `finish()` |
| `tests/integration/test_utils.ts` | Shared suite runner: `createSuite()` (`check()` + `finish()`; `finish()` auto-runs `restCleanup()`) |
| `tests/units/plantuml_check.ts` | Pure-logic check of the PlantUML preview rendering (fence rewrite, `!pragma sourceFile` injection, svg/png, newpage, escaping, `!include` — no dev host, no server) |
| `tests/units/plantuml_inline_check.ts` | Pure-logic check of the PlantUML SVG inlining (img→svg replacement, span copy, graceful failure — stubbed fetcher, no dev host, no server) |
| `tests/units/mermaid_check.ts` | Pure-logic check of the mermaid source-span rewrite (no dev host) |
| `tests/units/plantuml_completion_check.ts` | Pure-logic check of the in-markdown PlantUML code completions: fence detection + catalog (no dev host) |
| `tests/units/plantuml_definition_check.ts` | Pure-logic check of the PlantUML definition/reference/hover/rename/highlight/code-lens/folding core (`src/plantuml/invocations.ts`) (no dev host) |
| `tests/integration/plantuml_note_highlight_check.ts` | Live CDP check of `note on link`/`-->` keyword tokenization after `end note` (`vue.volar` corrupts `{{salt }}` SALT blocks; section 3f) |
| `tests/integration/mermaid_stale_check.ts` | Live CDP regression check: no `.hmk-stale-holder` badge during a mermaid re-render |
| `exp/e2e-anchor.cjs` | Scroll-anchor E2E: edit a mermaid block, assert the reading position survives the async re-render |

---

All tests are TypeScript and run with **bun**. The pure-logic unit checks
import `src/**/*.ts` directly — no compile step needed. The CDP integration
checks also run with bun but need a compiled extension (`npm run compile`) and
a running environment (code-server or dev host). The [`cdp.ts`](../tests/integration/cdp.ts)
shared helper detects the topology (OOPIF vs nested-iframe) automatically and
adapts `pEval`/`pClick` accordingly.

**Fixture paths (`tests/samples/…`) are resolved, not hardcoded.** The
`*_ix.ts` suites that open fixtures go through `SAMPLES`/`WORKSPACE` from
[`tests/integration/test_utils.ts`](../../tests/integration/test_utils.ts),
which picks the extension root as the extension host sees it: `HMK_EXT_ROOT`
if set, else the canonical code-server mount
`/home/lamnt45/git/vscode-hacker-markdown` when it exists, else the checkout
derived from the test file's own location. Set `HMK_EXT_ROOT=/path/on/host`
when the runner and the extension host don't share a filesystem (e.g. a
remote dev host).

## Prerequisites

- [Bun](https://bun.sh) (runs the TypeScript test suite directly — `bun tests/...`)
- Node.js (for `npm run compile`)
- The extension compiled: `npm run compile` (compiles `src/` → `out/`, and
  bundles `src/webview/**` → `build/index.js`) — only needed for the CDP tests
  and the extension itself, not for the pure-logic unit checks
- **Option A only:** the code-server stack up —
  `/home/lamnt45/git/vscode-hacker-meta/docs/important/dev-code-on-nuc-test-on-pp.md`
- **Option B only:** a local build of VS Code on the `code` CLI

## Option A: code-server in Docker (preferred)

Everything about the environment — topology, ssh tunnels, docker compose,
TLS certificate, login, browser launch, restart (`hotload`), gotchas — is
documented **once**, in the meta repo:

> **`/home/lamnt45/git/vscode-hacker-meta/docs/important/dev-code-on-nuc-test-on-pp.md`**
> (*Dev on nuc, test on pp*). Read it first. This section covers only what
> is specific to *this* extension: the install, the workspace URL, and how
> to reach the preview webview DOM.

### One-time install (symlink)

code-server loads the extension straight from the repo: a symlink in its
extensions dir is the entire install:

```sh
ln -sf /home/lamnt45/git/vscode-hacker-markdown \
  /home/lamnt45/git/vscode-hacker-meta/exp/code-server/.local/share/code-server/extensions/hacker-markdown
```

The `${HOME}/git` mount is live, so `package.json`/`out/`/`build/` are read
as-is from the working tree — but a running code-server caches the loaded
extension, so after every rebuild restart it and reload the browser tab:

```sh
npm run compile      # here
hotload code-server  # meta repo — defined in the doc above
```

### Drive it from the pp browser

With the stack up (per the meta doc), point the chrome-devtools MCP tools
(or any raw CDP client) at the pp browser and:

1. Open
   `https://localhost:9620/?folder=/home/lamnt45/git/vscode-hacker-markdown`.
2. First visit per folder: the **Restricted Mode** banner blocks extension
   activation — click "Restricted Mode" in the status bar (or `Manage` in
   the banner) → **Trust** (remembered in the mounted user-data-dir, so
   this is once per folder).
3. Open `tests/samples/workspace/test.md` from the Explorer.
4. Command palette (`Ctrl+Shift+P`) → `Hacker Markdown: Open` — the preview
   webview loads from the symlinked extension.

### Reaching the webview DOM

Unlike the dev host (Option B), a code-server webview is **not** a separate
OOPIF CDP target: `/json/list` shows no `vscode-webview://` iframe target.
The webview is nested iframes *inside the workbench page*, so evaluate from
the workbench page target and dive through the frames — find this
extension's webview by its iframe `src`:

```js
document.querySelector('iframe[src*="extensionId=lamnguyenx.hacker-markdown"]')
  .contentDocument                           // the webview bootstrap frame
  .querySelector('iframe').contentDocument   // the preview document
```

The inner document is the same DOM the dev-host tests see: `.toolbar`,
`.doc-name`, `.markdown-body`, `[data-zoom-step]`, `.hmk-frame`,
`[data-line]`, … — assert on it exactly like `tests/integration/test_preview.ts` does.

### Trade-offs vs the dev host (Option B)

- ✅ real browser + real user extensions (no `--disable-extensions` caveats,
  mermaid/puml plugins just work);
- ✅ interactive MCP tooling (click / type / screenshot / evaluate) reaches
  the whole workbench — editor, palette, explorer, webview;
- ⚠️ `hackerMarkdown.media.*` and other Global-scope settings persist in the
  mounted `…/code-server/User/settings.json` — when testing settings, check
  it for leftovers first (`grep hackerMarkdown` there) and clean stale keys;
- ❌ some tests require keyboard-driven interactions (save, palette, link
  navigation via CDP mouse) which are limited under browser-based CDP —
  these were removed from `test_preview.ts` under code-server; the
  eval-based checks (rendering, cursor sync, frames, mermaid) all pass;
- ❌ the `tests/*/*.ts` suite (open_view / test_preview / e2e-anchor) previously
  targeted only the dev host OOPIF topology — now `cdp.ts` auto-detects the
  topology and works under both; some palette-keyboard tests remain dev-host
  specific;

## 1. Launch the Extension Development Host

The extension is NOT loaded in a normal VS Code window. Run it as a dev
extension in its own instance with a debug port:

```sh
cd /Users/lamnt45/git/vscode-hacker-markdown
vscode_cdp --profile "$PWD/exp/devhost" --file "$PWD/tests/samples/workspace/test.md"
```

`vscode_cdp` (from `bach_cli/bach/vscode.sh`) runs on macOS and Linux. It
gracefully shuts down any previous dev host bound to the same CDP port
(`vscode_cdp_kill` — SIGTERM to the main process only, so no "Closed …
Reopen?" dialog), launches `code` detached (`nohup` on macOS,
`systemd-run --user`/`setsid` on Linux), then polls the CDP port until the
window is up and returns. **Unlike the previous in-repo scripts it does NOT
restore the previously active app/window — the dev host steals focus on
launch.** Plan for that, or run `vscode_cdp` and switch back manually.

Default profile is `~/.local/share/vscode-cdp/cdp-<port>` (shared across
projects); pass `--profile "$PWD/exp/devhost"` for a per-repo profile.
Default file is none (a Markdown editor is *not* active at startup, so the
preview stays empty until you open one) — pass `--file
"$PWD/tests/samples/workspace/test.md"` to match the smoke-test's preconditions.

For other fixtures/profiles/ports it accepts `--file`, `--profile`, `--port`:

```sh
vscode_cdp --profile "$PWD/exp/devhost" --file "$PWD/tests/samples/workspace/e2e-anchor.md"                    # scroll-anchor E2E (section 3b)
vscode_cdp --profile "$PWD/exp/devhost" --file "$PWD/tests/samples/enroll-flow-elements.puml.md"   # puml frames (section 3d)
vscode_cdp --port 9337 --profile "$PWD/exp/devhost-puml" --file "$PWD/tests/samples/enroll-flow-elements.puml.md"  # isolated puml host (section 3e)
```

The underlying command it runs (for reference; the function also handles the
kill around it):

```sh
code --extensionDevelopmentPath="$PWD" \
     --user-data-dir="$PWD/exp/devhost" \
     --remote-debugging-port=$CHROME_CDP_PORT$ \
     --new-window \
     "$PWD/tests/samples/workspace/test.md"
```

(The `Run Extension` launch config from `F5` starts the same host; the
pipeline below just pins the port and fixture explicitly.)

The preview appears in the bottom Panel under the "Hacker Markdown" tab. Drag
its header to the Primary Sidebar if you prefer it there — in a fresh profile,
toggle the panel once with `Cmd+J` so the container switcher appears.

Notes:

- `--user-data-dir` with a fresh profile forces a **separate instance**; without
  it, the window would join an already-running VS Code and ignore the port.
- **`--disable-extensions` is the default: only the extension under development
  loads, plus VS Code built-ins.** The built-in `vscode.mermaid-markdown-features`
  (VS Code ≥ 1.90) renders `.mermaid` blocks in the preview, so check 7 (mermaid)
  passes without `bierner.markdown-mermaid`; the suite is green and startup is
  fast, with no extra webview targets to confuse the helpers. Pass
  `--with-extensions` to load the real user extensions instead — needed on older
  VS Code without the built-in mermaid renderer (mermaid then requires
  `bierner.markdown-mermaid`), for puml rendering, which requires
  `jebbs.plantuml`, and whenever you want *your installed user extensions* in
  the host (themes, keymaps, …). With `--disable-extensions`, puml stays a
  plain code block and an installed theme (e.g. `lamnguyenx.vscode-eink-60hz`)
  never appears in the dev host's theme picker — that is expected, not a
  broken install. Two related traps:
  - an extension installed **while a dev host is already running** is picked
    up mid-session by the shared process ("Extensions added from another
    source" in `sharedprocess.log`), but the freshly launched host can also
    skip a folder whose install was in flight during its startup scan —
    after installing anything, relaunch the dev host once before debugging
    "the host doesn't see it";
  - the dev-host profile is reused across launches, so *applied* state (the
    current color theme, open tabs) persists — a theme applied in the dev
    host once stays applied on later relaunches.
  The test helpers always find the preview by probing for `.toolbar .doc-name`,
  never by target order.
- Opening `tests/samples/workspace/test.md` as the file argument makes a Markdown editor
  active at startup, so the preview renders immediately.
- **The dev-host profile carries `"editor.editContext": false`.**
  VS Code 1.13x defaults `editor.editContext` to on (Chromium EditContext
  input), which makes the editor ignore `Input.insertText` (see quirks.md §
  CDP input automation). The scratch profile
  (`exp/devhost/User/settings.json`) disables it so the suite's
  type-and-save checks work; if you recreate the profile from scratch, add
  it back or expect the live-edit checks to fail.
- The harmless warning `'remote-debugging-port' is not in the list of known
  options` can be ignored. (The CLI prepends its own
  `--remote-debugging-port=9333`; Chromium lets the **last** occurrence win,
  so the window still binds $CHROME_CDP_PORT$.)

### Linux-specific notes

- **The `code` on PATH must already be the native desktop binary.**
  `vscode_cdp` does not locate it for you — the previous in-repo script did,
  by scanning `/usr/share/code/code`, `/usr/bin/code`, `/opt/...`, validating
  against `resources/app/product.json`, and rejecting anything under
  `.vscode-server`. Inside a Remote-SSH / vscode-server session the `code`
  on PATH is a thin CLI wrapper that cannot run a dev host (it rejects
  `--extensionDevelopmentPath`, `--user-data-dir` and
  `--remote-debugging-port`). See
  [`native-vs-remote-ssh-vscode.md`](native-vs-remote-ssh-vscode.md). Make
  sure the native binary is first on PATH, or use whatever wrapper your
  environment provides to point at it.
- **Display.** `$DISPLAY` must be set and reachable when the launch happens
  — `vscode_cdp` errors out otherwise, with no auto-detection of X sockets.
  A headless box needs `xvfb-run` or a real X server.
- **Detachment.** The host is launched via `systemd-run --user` when available
  (so it survives the launching shell), else `setsid nohup`. The log goes to
  `${XDG_STATE_HOME:-$HOME/.local/state}/bach/vscode-cdp-<port>.log`.
- **Orphaned CDP-port holders.** Chromium spawns a `dconf watch /system/proxy/`
  helper (GLib proxy watching) that inherits the CDP listening socket fd. When
  the dev-host main process is killed, the helper survives, keeping the port in
  a zombie LISTEN state (connections hang, curl times out) — the next launch
  then fails to bind. `vscode_cdp_kill` detects the non-serving holder
  via `ss` and frees it; if a relaunch still hangs, kill it manually:
  `ss -tlnp | grep :$CHROME_CDP_PORT$` → kill the listed `pid`.

Verify the extension registered:

```sh
curl -s http://127.0.0.1:$CHROME_CDP_PORT$/json/list          # workbench page target
```

or run `Hacker Markdown: Open` / `Hacker Markdown: Open Preview in Editor` /
`Hacker Markdown: Refresh Preview` from the command palette.

## 2. Prepare the Workbench (one-shot)

A fresh dev-host profile needs three manual-ish steps before the preview exists:

```sh
bun tests/integration/open_view.ts $CHROME_CDP_PORT$
```

This script does, in order:

1. **Dismiss the one-time onboarding overlay.** Fresh profiles show a
   "Welcome to VS Code / Continue with GitHub" modal
   (`.onboarding-a-signin`). It intercepts *all* mouse/keyboard input — CDP
   events land on it and never reach the editor or palette. Clicking its close
   button (`.onboarding-a-close-btn`) dismisses it (this matches the behavior
   of `onboardingVariationA.ts`: the overlay is skipped on close). This was
   the first big gotcha: a fresh window may look fine but swallow every key.
2. **Toggle the panel until its container switcher materializes.** The panel
   container bar (`.composite-bar`) is rendered lazily — right after launch the
   panel may be visible but its tab list is empty. `Cmd+J` toggles it; poll for
   the "Hacker Markdown" tab.
3. **Click the "Hacker Markdown" tab** with a real CDP mouse event.
4. **Wait for the webview OOPIF target** to show up in `/json/list` (type
   `iframe`, URL starting `vscode-webview://`).

Without step 2-4 the panel tab is not in the DOM and there is no OOPIF target
to attach to.

## 3. The Functional Smoke Test

```sh
bun tests/integration/test_preview.ts $CHROME_CDP_PORT$
```

The 21 checks (current status: **all passing**):

| # | Check | What it proves |
| --- | --- | --- |
| 1 | Initial render: doc-name = `test.md` | Active-editor tracking at startup |
| 2 | Headings rendered | `markdown.api.render` output lands in the DOM |
| 3 | Highlighted code block (`pre code span.hljs-keyword`) | Engine syntax highlighting present |
| 4 | Table rendered | GFM output present |
| 5 | Empty state hidden / preview visible | Initial state is correct |
| 6 | `[data-line]` source markers present | Scroll-sync metadata rendered |
| 7 | Mermaid diagram rendered (`#preview .mermaid svg`) | Contributed `markdown.previewScripts` (mermaid) load and render `.mermaid` blocks |
| 7b | Image wrapped in a pan/zoom frame (`.hmk-frame`) | Generic frames apply to block-level imgs (plantuml-style output) |
| 7c | Mermaid is not double-framed | Frame scanning skips `.mermaid-wrapper` (the mermaid extension self-frames) |
| 7d | Frame zoom-in / Alt+drag pan / reset work | The frame interaction model (transform on `.hmk-frame-content`) |
| 7e | Cursor sync — exact line / containing-block / in-code-fence highlight | `.hmk-cursor` follows the cursor: exact `data-line`, blank-line → paragraph fallback, inside a fence → the `<pre>` (three checks) |
| 7f | Click-to-source — preview click moves the editor cursor | Clicking a rendered block in the preview re-highlights it (the host moves the editor selection and the echo cursor-sync brings the box back) |
| 7g | Click-to-source — mermaid diagram click jumps to the fence | Clicking the rendered `.mermaid-wrapper` re-highlights it (`.mermaid` carries `data-hmk-from`; the host's document scan supplies the span) |
| 8 | Link click opens `sub.md` and preview follows | Relative link resolution + follow-active-editor |
| 9 | `sub.md` content rendered | Second document renders |
| 10 | Re-render after save shows typed text | `hackerMarkdown.renderOnSave` (default on): a saved edit re-renders the preview |
| 11 | Mermaid re-renders after a saved edit | `vscode.markdown.updateContent` event dispatched after content updates |
| 12 | Second preview webview created | `Open Preview in Editor` works |
| 13 | Editor panel follows the same document | Shared render controller |
| 14 | Editor panel hides the Open-in-Editor button | Host chrome varies by container type |
| 15 | Empty state for a non-markdown active editor | Empty-state messaging on editor switch |

### How the checks work

- **The `contentDocument` gotcha.** VS Code's webview bootstrap writes the
  extension's HTML into a child frame of the OOPIF, so every expression must
  reach `document.querySelector('iframe').contentDocument` (the `d` variable
  in the test helpers). The OOPIF target is found by probing each
  `vscode-webview://` target for a `.toolbar .doc-name` element.
- **Ground truth.** Rendering is done by the *built-in* markdown extension via
  `markdown.api.render`, so the fragment HTML itself is trusted; we assert on
  what the webview did with it (headings, `hljs` spans, tables, `data-line`
  attributes).
- **Trusted CDP input only.** The command palette is driven with real
  `Input.dispatchKeyEvent` (Meta+Shift+P) and `Input.insertText`; the view tab
  and document tabs are clicked with `Input.dispatchMouseEvent`. Synthetic
  DOM events are only used for things inside the webview itself (e.g. setting
  the scroll position). This matters because VS Code's keybinding service only
  reacts to trusted events.
- **Exact palette-row clicking.** The palette's fuzzy matcher can rank a
  different item first (typing `File: New Untitled Text File` matches
  `File: Compare New Untitled Text Files` more strongly!). `runPaletteCommand`
  therefore locates the row whose text *starts with* the exact command and
  clicks it with a real mouse event.
- **Scroll into view before clicking.** `elementFromPoint` returns `null`
  (and CDP clicks miss) for elements below the visible area — the panel is
  short, so links far down the page must be scrolled into view first
  (`scrollIntoView({block:'center'})`).
- **Editor panels are separate targets.** The editor-area preview is a second
  `WebviewPanel`, i.e. a second OOPIF target. The test distinguishes it from
  the docked view by comparing `webSocketDebuggerUrl` across `/json/list`
  fetches (object identity does not survive re-fetching).

### Sequence gotchas worth knowing

- `File: New Untitled Text File` opens the untitled file in a **new editor
  group**; the empty-state check therefore clicks the `Untitled-1` tab to make
  it the active editor, because the preview follows the *active* editor (a
  group with no active editor keeps the last preview, matching the built-in
  preview's behavior).
- After clicking a link in the preview, `showTextDocument` has already focused
  the editor, so `Input.insertText` lands in it without any extra click — a
  click is not only unnecessary, it can steal focus and make the save-render
  check flaky.
- **The cursor-sync checks drive the editor with `Ctrl+G` (Go to Line).**
  After moving the cursor, the host broadcasts the line and the webview
  highlights immediately (no re-render needed), so the checks poll the webview
  for `.hmk-cursor` rather than waiting for a render. The editor must be
  focused first (a real CDP click on `.monaco-editor`), and the go-to-line
  input takes the **1-based** line number while the fragment's `data-line`
  attributes are 0-based — the checks assert on `data-line`.
- **The click-to-source checks (7f/7g) assert the echo, not the editor DOM.**
  They start from the 7e state (editor on the python fence), CDP-click a block
  inside the preview OOPIF (the `h3[data-line="6"]` and then the rendered
  `.mermaid-wrapper`), then assert `.hmk-cursor` lands on that block. The
  highlight only moves because the host moved the editor selection (which fired
  `onDidChangeTextEditorSelection`, echoing the line back) — so the echo *is*
  the end-to-end proof of the whole chain (click → `editorLine` message →
  editor selection → echo highlight), without needing monaco introspection.
  Real trusted clicks only (synthetic `.click()` would skip the coordinate
  resolution in `sourceLineForClick`). Note: click the visible
  `.mermaid-wrapper`, not the `.mermaid` `<pre>` — it is `display: unset`
  (inline), so its own rect is a sliver.

## 3b. Scroll-Anchor E2E (diagram re-render)

The smoke test does not assert scroll positions, so the async-diagram case
(edit a puml/mermaid block → the rendered diagram reloads → does the reading
position survive?) has its own script. It needs the dev host launched with
the fixture document (it edits the mermaid block on a known line):

```sh
vscode_cdp --profile "$PWD/exp/devhost" --file "$PWD/tests/samples/workspace/e2e-anchor.md"
bun tests/integration/open_view.ts $CHROME_CDP_PORT$
node exp/e2e-anchor.cjs $CHROME_CDP_PORT$   # PASS: reading position held across mermaid re-render
git checkout -- tests/samples/workspace/e2e-anchor.md   # the run saves the inserted node into the fixture
```

What it does: focuses the editor, jumps to the last mermaid line
(`Ctrl+G` + `End`), inserts a node that grows the diagram, asserts the
preview did **not** re-render while typing (render-on-save is the default),
saves (Cmd+S), then asserts three things:

1. **No collapse while re-rendering** — a "Re-rendering…" keeper badge
   (`.hmk-stale-holder`) appears and the note below the diagram does not
   jump upward (the placeholder is held at its old height until the new
   render lands; the diagram may legitimately grow *downward*);
2. **The re-render happened** — the new SVG contains the inserted node;
3. **The position is restored** — the note is back within 4px of its
   pre-edit position and the badge is gone.

Gotchas baked into the script:

- **Monaco virtualizes lines** — a line only exists in the DOM once it is
  scrolled into view. Never click a line by DOM query without scrolling
  first (or use `Ctrl+G` which works regardless of scroll).
- **Session restore** — the dev-host profile restores the previous cursor
  position on relaunch, so "click the editor, then ArrowDown ×N" is not
  deterministic. `Ctrl+G` + `End` is.
- **`End` before inserting** — inserting at column 1 of a mermaid line
  corrupts the diagram (the old line content merges onto the inserted
  line), which removes the SVG and makes the assertion crash on `null`.
- **Render happens on save, not on keystroke** — any test that edits a
  document and expects a re-render must send Cmd+S (trusted key event with
  `modifiers: 4`) afterwards; assertions made between typing and saving
  must expect the *old* content.
- **The keeper window can be very short** — a tiny diagram re-renders in
  <16ms, so the badge poll must be tight (15ms) and the keeper's badge has
  a 120ms minimum life. Don't "simplify" the poll to 100ms.
- **Session restore can hand you a corrupted buffer** — the restored editor
  buffer can differ from disk (hot exit); observed: a stray edit left the
  mermaid fence unclosed, turning the rest of the doc into the diagram
  source. When a run misbehaves inexplicably, wipe
  `exp/devhost/User/workspaceStorage/*/backups` and relaunch.

## 3c. The Harness (webview logic in a plain page)

`exp/scroll-anchor-test.html` drives the *real* `build/index.js` (the
esbuild bundle of `src/webview/**`) in a
plain page (stubbed `acquireVsCodeApi`) to test the stale-diagram keepers
cross-renderer: scenario A is the container pattern (mermaid: placeholder
held at its old height + badge), scenario B is the img pattern (plantuml:
old img kept in flow until the new one loads). It needs two local servers:

```sh
npm run compile                                     # build/index.js + build/*.css (bundle + copied src/media)
python3 -m http.server 8377 --bind 127.0.0.1 &   # serves the harness + build
node exp/slow-img-server.cjs &                    # 2s-delayed image on 8378
# open http://127.0.0.1:8377/exp/scroll-anchor-test.html in a browser;
# the page title flips to PASS/FAIL and window.__log has the detail.
```

Harness-specific gotchas: it must load `build/main.css` (the badge CSS is
part of the behavior), then override `html, body { height: auto !important }`
after it — main.css's `height: 100%` shrinks the sticky toolbar's
containing block in a plain page and silently breaks every scroll
measurement.

## 3d. PlantUML (puml) diagrams

The dev host renders puml only when *both* hold:

1. Launched with `--with-extensions` (the default is all extensions disabled;
   `--with-extensions` loads the real user extensions) — `jebbs.plantuml` must
   load (it contributes `markdown.markdownItPlugins: true` and
   `extendMarkdownIt`, so the plugin runs inside `markdown.api.render`).
2. A PlantUML server configured in the dev host profile
   (`exp/devhost/User/settings.json`):
   ```json
   "plantuml.server": "http://localhost:9274",
   "plantuml.render": "PlantUMLServer"
   ```
   (match the values in your real VS Code settings; the server itself is not
   part of this repo). Without a server the plugin emits a `⚠️` placeholder
   `<pre>` with the diagram source — no `<img>`, no frames.

To verify the pan/zoom frames against `tests/samples/enroll-flow-elements.puml.md`:

```sh
vscode_cdp --with-extensions --profile "$PWD/exp/devhost" --file "$PWD/tests/samples/enroll-flow-elements.puml.md"
bun tests/integration/open_view.ts $CHROME_CDP_PORT$
node exp/probe_all.cjs $CHROME_CDP_PORT$ "<expr>"   # iterate ALL iframe targets (extra webviews present)
node exp/persist_test.cjs $CHROME_CDP_PORT$          # zoom -> save -> zoom restored
```

Expected: 12 puml `<img>`s, all wrapped in `.hmk-frame`; zoom-in / Alt+drag
pan / reset work; zoom+pan state survives a save-triggered re-render (the
frame state is keyed by the img `src`, and plantuml URLs encode the diagram
source). Why the framing works: the markdown-it plugin emits the `<img>` as a
*direct child of `#preview`* (block level, no `<p>` wrapper), so
`isFrameable` must not treat block siblings (H2/H3…) as "inline prose" —
the sibling check applies only inside phrasing containers (`p`/`span`/…).
The pan/zoom fixture checks in `tests/integration/test_preview.ts` (7b–7d) cover the
same behavior on `test.md`'s `<p>`-wrapped image.

## 3e. PlantUML rendering (no jebbs.plantuml required)

`puml` / `plantuml` / `uml` fences render as PlantUML-server SVG images
**without** `jebbs.plantuml` (see `docs/plans/2026/08/04/2026-08-04-plantuml-markdown-preview-rendering.md`
and `docs/important/architecture.md`). The rewrite happens extension-side on
the fragment returned by `markdown.api.render`, so the stock preview is
unaffected. The rendering core (`src/plantuml/{fences,diagram,type,plantumlURL,include}.ts`)
is pure (no `vscode` import) and is unit-checked against the real shipped code
without a dev host or a compile step (bun runs the TypeScript sources directly):

```sh
bun tests/units/plantuml_check.ts   # fence rewrite, svg/png, newpage, escaping round-trip, !include
```

The e2e path (isolated host, a real server) is documented in the plan doc:

```sh
# fresh profile => ONLY this extension loads (all extensions disabled, which is the launch default);
# plantuml.server = http://localhost:9274 in exp/devhost-puml settings
vscode_cdp --port 9337 --profile "$PWD/exp/devhost-puml" \
     --file "$PWD/tests/samples/enroll-flow-elements.puml.md"
bun tests/integration/open_view.ts 9337
# assert: a puml fence rendered an <img> (decoded from the server URL) wrapped in .hmk-frame
```

Also covered by `plantuml_check.ts`: with `hackerMarkdown.plantuml.server`
empty, a puml fence becomes the `.hmk-puml-error` notice with an *Open
Settings* button (opens the setting via `workbench.action.openSettings`),
instead of an image.

The diagrams are **inlined SVGs**, not `<img>`s: after the fence rewrite the
extension fetches each SVG (host-side, no CORS) and splices it into the
fragment (`src/plantuml/inlineSvg.ts`). This is what lets the webview read the
salt-capable server's `data-source-code` ranges for cursor highlight and
click-to-source, and what keeps the canvas clamped (the SVG is wrapped in the
usual `.hmk-frame` pan/zoom frame — `max-width: 100%`). The pure logic is
pinned by `tests/units/plantuml_inline_check.ts` (stubbed fetcher) and the SALT
invocation scan by `tests/units/plantuml_check.ts`. For the full salt-sync e2e
(cursor over a mockup → the mockup gets the box; clicking it selects the exact
source lines), run the dev host against `tests/samples/enroll-flow.puml.md`
with the locally-built server on 9274: note-on-link mockups jump to their
`{{salt` block, and procedure-rendered activity mockups (one per distinct
`SALT(x)` alias) jump to the first invocation line.

## 3f. TextMate / syntax highlighting (grammars)

The extension contributes TextMate grammars (`syntaxes/*`): `source.wsd`
for `.puml`/`.wsd`/… files plus an injected grammar that re-scopes
`plantuml`/`puml`/`uml` markdown fences. Grammar regressions are easy to
miss because token *colors* are theme-dependent (a monochrome eink theme
renders every scope one color — it looks like "no highlighting" even when
tokenization works). Verify scopes, not colors:

- Run `Developer: Inspect Editor Tokens and Scopes` (hover/`Cmd+Shift+P`),
  put the cursor on a fence-content line, and read the `textmate scopes`
  line. A `plantuml`/`puml` fence body must show
  `meta.embedded.block.plantuml` + `diagram.source.wsd` on top of the
  markdown scopes. You can also read the DOM: `.view-line` children carry
  `.mtk*` classes, but those only distinguish *colors* — they prove nothing
  under a monochrome theme, so prefer the inspector.
- Move the cursor deterministically with `Ctrl+G` (go to line) — clicking
  the editor body is not precise. `monaco` virtualizes lines: only rendered
  lines are in the DOM, so scroll first (see quirks.md for why
  `scrollTop = scrollHeight` is a trap in backgrounded windows).
- **Open editors cache tokens.** After changing `syntaxes/*` or
  `package.json#contributes.grammars`, an already-open document keeps its
  old tokenization until it is *closed and reopened* (or the extension
  restarted) — `Reload Window` alone is not always enough. If the fixture
  still shows no highlighting after a dev-host relaunch, close/reopen the
  tab.
- **Final colors & font styles are theme-dependent — verify offline, not by
  eye.** The inspector shows *scopes*, not the final paint: the foreground and
  fontStyle (bold/italic/underline) a token gets come from the *active theme's*
  `tokenColors` (+ user `editor.tokenColorCustomizations.textMateRules`) matched
  against the scope. The model order-of-magnitude check
  (`node exp/themecheck/tokenize.cjs` / `..._theme_only.cjs`) feeds the shipped
  `plantuml.tmLanguage.json` through the real `vscode-textmate` with the theme
  applied exactly as VS Code does, and prints per-token color+style. The shipped
  grammar is deliberately re-scoped onto standard families (`keyword.other`,
  `variable.other.enummember`, `entity.name.function`, …) so the Eink 60Hz
  theme's rules style fence tokens; if a token looks "wrong", check its scope
  first, then which theme rule colors it.
- **Diagnose a silent "no highlighting" by grepping the logs.** A grammar
  that fails to load logs once per extension-host session in `renderer.log`:
  `grep "Unable to load and parse grammar" "$LOG_DIR"/window*/renderer.log`
  → `…Unable to resolve nonexistent file '…/syntaxes/codeblock.json'`
  means the grammar files are missing from the extension folder (see Makefile
  `install`, which now copies + verifies `syntaxes/`).
- **`vue.volar` corrupts `{{salt }}` SALT mockups.** Volar's
  `vue.interpolations` injection grammar (`injectionSelector:
  L:text.html.markdown -comment.block`, `begin: {{ / end: }}`) matches the
  PlantUML SALT `{{salt …}}` syntax on the *markdown* scope and swallows the
  scan inside ` ```plantuml ` fences — after the first `note on link … end
  note` block, EVERY subsequent line in that fence collapses to a single
  flat `mtk*` span (the `>` of `-->` is also flagged
  `unexpected-closing-bracket`). This is reproducible on the dev host with
  `--with-extensions` but NOT with `--disable-extensions` or
  `--disable-extension vue.volar`. Catch it with
  `bun tests/integration/plantuml_note_highlight_check.ts $VSCODE_CDP_PORT$`. See §3i for the full
  injection-conflict debugging workflow.
  Full write-up:
  `docs/issues/bugs/2026/08/21/2026-08-21-note-on-link-highlight-lost-after-end-note.md`.

## 3g. Injection-grammar conflicts (extension A/B workflow)

Grammar debugging often looks like "everything tokenizes correctly in
standalone `vscode-textmate`" but falls apart in the real window. The reason
is almost always an **injection grammar from another extension** that matches
syntax inside our fences. This section documents the A/B technique for
isolating and fixing such conflicts.

### The workflow (in 60 seconds)

```sh
# 1. Compile (skip full build if only grammar files changed)
npm run build:syntax       # plantuml.yaml-tmLanguage → plantuml.tmLanguage.json

# 2. Launch with the suspect fixture (Volar enabled = the "broken" side)
vscode_cdp_kill $VSCODE_CDP_PORT$
vscode_cdp --port $VSCODE_CDP_PORT$ --with-extensions \
  --profile "$PWD/exp/devhost-withext" \
  --file "$PWD/tests/samples/enroll-flow.puml.md"

# 3. Close & reopen the fixture tab (grammar changes are never hot-reloaded
#    on already-open tabs; close Cmd+W, reopen Ctrl+P → Enter)
#    Then probe with the regression test:
bun tests/integration/plantuml_note_highlight_check.ts $VSCODE_CDP_PORT$

# 4. Isolate the culprit with the "Volar-off" control:
vscode_cdp_kill $VSCODE_CDP_PORT$
setsid nohup /usr/share/code/code \
  --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost-withext" \
  --remote-debugging-port=$VSCODE_CDP_PORT$ --with-extensions --disable-extension vue.volar \
  --new-window "$PWD/tests/samples/enroll-flow.puml.md" \
  > exp/devhost-launch.log 2>&1 < /dev/null &
bun tests/integration/plantuml_note_highlight_check.ts $VSCODE_CDP_PORT$     # should PASS
```

### Three controls, one conclusion

| Control | Command | Result says |
| --- | --- | --- |
| **A — Extensions off** | `vscode_cdp` (default `--disable-extensions`) | "our grammar works in isolation" |
| **B — All extensions** | `--with-extensions` | "some user extension collides" |
| **C — All extensions – suspect** | `--with-extensions --disable-extension vue.volar` (call `code` directly — no function passthrough) | "this extension IS the trigger" |

### Scope-stack forensics

Mtk classes (`mtk5`, `mtk10`, …) only tell you *colors*, not *who* assigned
them. When a token looks wrong, use `Developer: Inspect Editor Tokens and
Scopes` (Cmd+Shift+P → type it) to see the FULL scope stack:

```
source.ts.embedded.html.vue          ← Volar owns this
expression.embedded.vue              ← Volar pushed this at {{salt
diagram.source.wsd                   ← our plantuml scope (underneath)
meta.embedded.block.plantuml
markup.fenced_code.block.markdown
text.html.markdown
```

If an injection grammar's scope appears **above** `diagram.source.wsd`, it has
hijacked the scan. The typical way to fix:

1. Read the offending extension's `injectionSelector` (e.g.
   `L:text.html.markdown -comment.block` for Volar).
2. Notice the `-comment.block` exclusion — it's a scope selector: the
   injection skips scans inside `comment.block.*`.
3. Opt your fence content into that exclusion by adding the scope to your
   `contentName`:
   ```diff
   -"contentName": "meta.embedded.block.plantuml",
   +"contentName": "meta.embedded.block.plantuml comment.block.plantuml",
   ```
4. Reload, close & reopen, re-test.

### Smoking-gun symbols

- `unexpected-closing-bracket` on ordinary `>` or `]` → an injection grammar
  opened a scope inside your fence and left it unbalanced.
- `bracket-highlighting-0` through `-5` in a file with only one level of
  `[]` nesting → bracket counters are being summed across your fence and
  an injection grammar.
- `source.ts.embedded.html.vue` or `source.ts` inside a PlantUML fence → a
  `{{ }}` interpolation grammar (Vue, Nunjucks, …) matched your SALT braces.

### Regression harness

`tests/integration/plantuml_note_highlight_check.ts` is a standalone CDP test that opens
the fixture, scrolls to the multi-line notes, and asserts every
`note on link` / `-->` line keeps >1 token span. It exits 0 (PASS) or 1
(FAIL). Use it as a gate before committing grammar changes:

```sh
# baseline (extensions off)
vscode_cdp --port $VSCODE_CDP_PORT$ --file "$PWD/tests/samples/enroll-flow.puml.md"
bun tests/integration/plantuml_note_highlight_check.ts $VSCODE_CDP_PORT$ && echo PASS

# real-world (with extensions)
vscode_cdp_kill $VSCODE_CDP_PORT$
vscode_cdp --port $VSCODE_CDP_PORT$ --with-extensions \
  --profile "$PWD/exp/devhost-withext" \
  --file "$PWD/tests/samples/enroll-flow.puml.md"
bun tests/integration/plantuml_note_highlight_check.ts $VSCODE_CDP_PORT$ && echo PASS
```

## 3i. PlantUML code completions (in-markdown IntelliSense)

`src/completions/*` adds PlantUML keyword suggestions *while typing* inside
`plantuml`/`puml`/`uml` markdown fences. The core (`src/completions/fences.ts`
fence detection + `words.ts` static catalog) is pure (no `vscode` import) and
is unit-checked against the real shipped code without a dev host or a compile
step:

```sh
bun tests/units/plantuml_completion_check.ts   # fence inside/outside, closed/unclosed, tilde, casing; catalog sizes + markers
```

The vscode boundary (`provider.ts`) is a completion provider registered on the
`markdown` language (VS Code cannot scope completions to an embedded grammar,
see microsoft/vscode#208862); it returns `undefined` unless the cursor is
inside a puml fence, reads `hackerMarkdown.completions.enabled`, and is
activated via `onLanguage:markdown`. Completions live in the **extension
host**, not the preview webview, so they are outside the OOPIF CDP harness —
verify by hand with the dev host open on a fixture with a puml fence:
Ctrl+Space (or type `@` / `!`) inside the fence shows the list; outside the
fence nothing pops. Guidance on activating/relaunching the host: sections
1–2 and 5.

## 3k. PlantUML go-to-definition (in-markdown IntelliSense)

`src/completions/definitions.ts` adds a `DefinitionProvider` that resolves
`SALT(<alias>)` inside `plantuml`/`puml`/`uml` markdown fences to the
matching `!procedure _<alias>()` definition in the same fence — F12 /
Alt+Click / Cmd+Click on the alias word jumps the editor cursor to the
definition line.

The core (`src/plantuml/invocations.ts` function `aliasDefinitions`) is pure
(no `vscode` import) and is unit-checked against the real shipped code without
a dev host or a compile step:

```sh
bun tests/units/plantuml_definition_check.ts   # alias→line mapping, per-fence isolation, duplicate alias, underscore stripping, tilde fences
```

The vscode boundary (`src/completions/definitions.ts`) is a definition provider
registered on the `markdown` language (same `fenceAt` self-filter pattern as
completions). Definitions live in the **extension host**, not the preview
webview, so they are outside the OOPIF CDP harness — verify by hand with the
dev host open on `tests/samples/enroll-flow.puml.md`: F12 on `enroll_uploading_1`
inside `SALT(enroll_uploading_1)` jumps to line 213
(`!procedure _enroll_uploading_1()`); F12 on a non-alias word silently does
nothing. Guidance on activating/relaunching the host: sections 1–2 and 5.

For a programmatic assertion, use the workbench CDP target with
`vscode.executeDefinitionProvider` (same pattern as `executeCompletionItemProvider`
documented in `quirks.md` §"Language features in embedded regions"):

```sh
# probe with the workbench target, position inside SALT(enroll_uploading_1)
cdp_eval workbench "...
  const loc = await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider',
    vscode.Uri.file('$PWD/tests/samples/enroll-flow.puml.md'),
    new vscode.Position(466, <char-pos>)
  );
  console.log(JSON.stringify(loc[0]));
"
```

Expect `"line": 212` (0-based definition line).

## 3l. PlantUML hover, rename, highlights, code lens, folding

All five live in `src/completions/definitions.ts`, registered on `markdown`,
self-gated by `fenceAt()`. The pure core (`aliasOccurrences`,
`procedureFoldRanges`, `procedureNames` in `src/plantuml/invocations.ts`) is
covered by the same pure-logic check as go-to-definition:

```sh
bun tests/units/plantuml_definition_check.ts
```

This exercises 31 checks across 11 sections, including `aliasOccurrences`
(definition + invocation detection, substring safety, repeated invocations),
`procedureFoldRanges` (pair matching, empty, non-puml), and `procedureNames`
(`!unquoted procedure` + `!procedure` detection).

**Manual dev-host checks** (`vscode_cdp --file
"$PWD/tests/samples/enroll-flow.puml.md"`):

1. **Hover** over `SALT(enroll_uploading_1)` → tooltip shows
   `!procedure _enroll_uploading_1()` + "2 references" + line number.
2. **F2** on `enroll_uploading_1` → rename offered; type `foo` → all
   `SALT(foo)` + `!procedure _foo()` updated; `SALT(enroll_extracting_1)`
   unaffected.
3. **Click** on `SALT(enroll_uploading_1)` → all occurrences highlighted
   (definition in `Write` color, invocations in `Read` color).
4. **Code lens** above `!procedure _enroll_uploading_1()` shows "2 references".
5. **Fold** the `!procedure _enroll_uploading_1() … !endprocedure` block.

**Completion enhancements** (`src/completions/words.ts` + `provider.ts`):
- All `@start`/`@end` diagram types and preprocessor directives are now in
  the static catalog (29 type + 109 keyword + 28 preprocessor + 514 skinparam
  + 154 color words).
- Dynamic procedure names (`SALT`, `_sample_row_empty`, `sample_row_empty`)
  are suggested inside puml fences via `procedureNames()`, which detects both
  `!procedure _name()` and `!unquoted procedure Name()`.
- The provider also fires on `(` so `SALT(` immediately shows all aliases.
- Verified by the catalog-sanity checks in `tests/units/plantuml_completion_check.ts`.

## 3j. Ctrl/Cmd+Shift+V override & cross-window placement

Two placement/shortcut features worth an explicit check:

- **Keybinding override.** The extension takes over `Ctrl+Shift+V`
  (`Cmd+Shift+V` on mac) from the built-in preview (and from third-party
  preview extensions that bind the same key) — it wins the same-key conflict
  because its binding is the 2nd contributed keybinding (weight 402, above the
  401-weight competitors; see the plan doc and `quirks.md`). To verify:
  1. Focus a markdown editor.
  2. Press `Ctrl+Shift+V` (trusted input). With
     `hackerMarkdown.overridePreviewShortcut: true` (default) our preview
     opens; with it `false` the built-in preview opens instead.
  3. For a deterministic assertion, run `Developer: Toggle Keyboard
     Shortcuts Troubleshooting` first — each press logs `From N keybinding
     entries, matched hackerMarkdown.togglePreview` (+ `Invoking command`) in
     the renderer console.
- **Serialized editor panel / move to another window.** The editor-area
  preview (`hackerMarkdown.panel`) survives `Reload Window` and can be moved
  to a new window (`View: Move Editor into New Window` with the panel tab
  active): VS Code serializes the panel, and the target window's extension
  host re-creates it via the `WebviewPanelSerializer` (`onWebviewPanel:`
  activation; the webview persisted the shown document via
  `acquireVsCodeApi().setState`). After the move there are two windows on the
  CDP port; close the extra one when done (session restore will keep reopening
  both until you do).
- **`hackerMarkdown.open` fallback.** Reveals the docked view when it has
  been resolved once; otherwise it opens (and reuses) the editor panel, so
  the command and the shortcut always show a preview — even in a fresh window
  where the panel view was never opened.

## 4. Reading the VS Code Logs

`exp/devhost/logs/<timestamp>/window1/exthost/exthost.log` records extension
activation, including the built-in markdown engine:

```
ExtensionService#_doActivateExtension vscode.markdown-language-features, startup: false, activationEvent: 'onLanguage:markdown'
ExtensionService#_doActivateExtension lamnt45.vscode-hacker-markdown, activationEvent: 'onCommand:hackerMarkdown.open'
```

If the preview never renders, check `renderer.log` for manifest/activation
errors and confirm `vscode.markdown-language-features` activated before the
first `markdown.api.render` call (it activates automatically on that command).

## 5. Re-running After an Edit

```sh
npm run compile                    # tsc -> out/ + esbuild -> build/ (bundle + copied src/media)
# restart the dev host (the function kills the old window on the same port first):
vscode_cdp --profile "$PWD/exp/devhost" --file "$PWD/tests/samples/workspace/test.md"
bun tests/integration/open_view.ts $CHROME_CDP_PORT$
bun tests/integration/test_preview.ts $CHROME_CDP_PORT$
git checkout -- tests/samples/workspace/sub.md tests/samples/workspace/e2e-anchor.md   # the suite saves live-edit tokens into the fixtures
```

### Grammar-only fast loop

When only `syntaxes/*` files change (no `.ts` / `src/` / `build/` changes),
skip the full `npm run compile` and use the abbreviated loop:

```sh
npm run build:syntax              # plantuml.yaml-tmLanguage → .tmLanguage.json
# (If codeblock.json changed, skip — that file is already .json)

# Relaunch the dev host (or just reload the window & close/reopen the tab)
vscode_cdp --port $VSCODE_CDP_PORT$ --file "$PWD/tests/samples/enroll-flow.puml.md"

# Close the fixture tab (Cmd+W), reopen (Ctrl+P → Enter) — THIS IS REQUIRED.
# Grammar changes are never hot-reloaded on already-open tabs (see §3f).
# Reload Window alone is not always enough.

# Probe:
bun tests/integration/plantuml_note_highlight_check.ts $VSCODE_CDP_PORT$

# A/B against Volar (see §3g for the full workflow):
vscode_cdp_kill $VSCODE_CDP_PORT$
setsid nohup /usr/share/code/code \
  --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost-withext" \
  --remote-debugging-port=$VSCODE_CDP_PORT$ --with-extensions --disable-extension vue.volar \
  --new-window "$PWD/tests/samples/enroll-flow.puml.md" \
  > exp/devhost-launch.log 2>&1 < /dev/null &
bun tests/integration/plantuml_note_highlight_check.ts $VSCODE_CDP_PORT$
```

After changing grammar files (`syntaxes/*`) or `package.json#contributes.*`
(the default `open_view.ts` fixture is `tests/samples/workspace/test.md`) remember:

- the dev-host restart re-reads `package.json`, but the **open editor keeps
  its cached tokens** — close and reopen `test.md` (or open the sample in
  section 3d) before asserting highlighting (see 3f);

**The legacy smoke suite is not idempotent.** `test_preview.ts` mutates the
dev host state as it goes (opens files, creates panels, switches editors), so
re-running it against a live host without a fresh launch produces bogus
failures (observed: checks 6/7/11 fail with a stray `scrollIntoView`
TypeError). Always restart the dev host between runs — and before
troubleshooting a failure, re-run once on a fresh host to rule out
contamination. Historically it also dirtied tracked fixtures by typing and
saving into `sub.md`; the current version no longer does, but any failed
palette input can still leak typed text into the open buffer — `git checkout`
the fixtures after a run if needed
(`tests/samples/workspace/sub.md`, `tests/samples/workspace/e2e-anchor.md`, any sample file
you opened).

**The REST-based `*_ix.ts` suites clean up after themselves.** Each one's
`finish()` runs `restCleanup()` (revert + close every dirty editor, close
leftover text tabs, delete `/tmp/hmk-*`), so they leave no unsaved files
behind and can be run back-to-back without re-running `open_view.ts` between
them (only the temperature of the workbench, not file state, limits batching —
see [Running multiple integration tests](#running-multiple-integration-tests-against-code-server)).

**The suite is load-sensitive.** Several checks have short windows (cursor
sync: 8s; save-triggered re-render: 10–20s), and under machine pressure
(other VS Code instances, competing build/install jobs, RAM exhaustion)
they fail even on a pristine checkout — the failure set is characteristic
(checks 7e + 10 + 11 together, with the typed token landing late or never).
Before treating a failure as a regression: re-run on a fresh host on a quiet
machine, or A/B against `git stash`; a `git log`-clean A/B that both pass on
retry means it was load, not code.

**Session restore can serve a stale host.** The dev-host profile restores the
previous session (open tabs, webview state), so a relaunch against a reused
profile can show a stale webview whose `.toolbar .doc-name` is empty while a
fresh one is still initializing — `test_preview.ts` then attaches to the
wrong target or times out. When a run misbehaves inexplicably after switching
fixtures, wipe the profile (`rm -rf exp/devhost`; the launch script recreates
it) or relaunch with `--profile "$PWD/exp/devhost-<name>"` for a fresh one.
On Linux, also make sure no orphan holds the port from the previous host
(`vscode_cdp_kill` handles this automatically).

**`make install` skips an unchanged version — bump it to reinstall.** The
install delegates to `vscode-hacker-meta`, which leaves an already-installed
version in place when `package.json#version` is unchanged. After changing
`package.json` (commands, keybindings, settings), bump the version (e.g.
`2026.8.18-3` → `-4`) or overwrite the extension dir in place
(`unzip -o` the vsix `extension/*` into
`~/.vscode/extensions/lamnt45.vscode-hacker-markdown-<version>`), then
`Developer: Reload Window`. Also note the `make install`/`make build` CLI can
forward to a **running** VS Code instance instead of installing locally — the
running window gets a live install that still needs a reload to activate.

---

## Quick Reference

| Task | Command |
| --- | --- |
| Pick an environment (agents: **ask the user first**) | **A** = code-server in Docker (preferred) · **B** = dev host |
| Restart code-server after a rebuild (Option A) | `npm run compile` here → `hotload code-server` from the meta repo (symlink install is one-time) |
| code-server workspace / CDP endpoint (Option A) | browser: `https://localhost:9620/?folder=/home/lamnt45/git/vscode-hacker-markdown` · CDP: `http://localhost:9024` — environment in `/home/lamnt45/git/vscode-hacker-meta/docs/important/dev-code-on-nuc-test-on-pp.md` |
| Start dev host (port $CHROME_CDP_PORT$) | `vscode_cdp` (flags: `--port`, `--profile`, `--file`, `--with-extensions`, `--ext`, `--no-ext`; default: all extensions disabled; Linux: requires native `code` on PATH, `$DISPLAY` set) |
| Stop dev host | `vscode_cdp_kill [port]` (graceful SIGTERM; no "Reopen?" dialog) |
| List CDP targets | `curl -s http://127.0.0.1:$CHROME_CDP_PORT$/json/list` |
| Prepare the view | `bun tests/integration/open_view.ts $CHROME_CDP_PORT$` |
| Full functional smoke test | `bun tests/integration/test_preview.ts $CHROME_CDP_PORT$` |
| Scroll-anchor E2E (start host with `tests/samples/workspace/e2e-anchor.md`) | `node exp/e2e-anchor.cjs $CHROME_CDP_PORT$` |
| Harness (webview logic; needs ports 8377/8378) | open `http://127.0.0.1:8377/exp/scroll-anchor-test.html` (section 3c) |
| Puml pan/zoom check (start host with `tests/samples/enroll-flow-elements.puml.md`; needs `plantuml.server` in the dev host profile) | `node exp/probe_all.cjs $CHROME_CDP_PORT$` + `node exp/persist_test.cjs $CHROME_CDP_PORT$` (section 3d) |
| PlantUML rendering pure-logic check (no dev host) | `bun tests/units/plantuml_check.ts` (section 3e) |
| PlantUML completion pure-logic check (no dev host) | `bun tests/units/plantuml_completion_check.ts` (section 3g) |
| PlantUML definition / hover / rename / highlights / code lens / folding pure-logic check (no dev host) | `bun tests/units/plantuml_definition_check.ts` (section 3k + 3l) |
| PlantUML SVG-inline pure-logic check (no dev host) | `bun tests/units/plantuml_inline_check.ts` |
| Mermaid span-rewrite pure-logic check (no dev host) | `bun tests/units/mermaid_check.ts` |
| All pure-logic checks (no dev host, no compile) | `npm run test:units` |
| Typecheck the test suite | `npm run typecheck:tests` |
| Mermaid stale-badge regression check (start host with `tests/samples/mermaid-fail.md`) | `bun tests/integration/mermaid_stale_check.ts $VSCODE_CDP_PORT$` |
| Keybinding override / serializer / cross-window move | section 3h (`Developer: Toggle Keyboard Shortcuts Troubleshooting` + `Move Editor into New Window`) |
| Evaluate in webview | `bun tests/integration/cdp_eval.ts $CHROME_CDP_PORT$ iframe vscode-webview:// "<expr>"` |
| PlantUML note-highlight check (start host with `tests/samples/enroll-flow.puml.md`) | `bun tests/integration/plantuml_note_highlight_check.ts $VSCODE_CDP_PORT$` (also works on `--with-extensions` hosts) |
| PlantUML render check (server → SVG inline, `data-hmk-from`/`data-hmk-to`) | `bun tests/integration/plantuml_render_check.ts $VSCODE_CDP_PORT$` |
| PlantUML IntelliSense (code lens, folding, F12 go-to-definition) | `bun tests/integration/plantuml_intellisense_ix.ts $VSCODE_CDP_PORT$` |
| Pin lifecycle (pin → editor switch → unpin) | `bun tests/integration/pin_lifecycle_ix.ts $VSCODE_CDP_PORT$` |
| Media toolbar dropdowns (invert / tables / column width) | `bun tests/integration/media_controls_ix.ts $VSCODE_CDP_PORT$` |
| Link navigation (relative `.md` link, `#fragment`) | `bun tests/integration/link_nav_ix.ts $VSCODE_CDP_PORT$` |
| renderOnSave gate (typing doesn't re-render) | `bun tests/integration/render_on_save_ix.ts $VSCODE_CDP_PORT$` |
| Editor-area preview (palette command creates tab) | `bun tests/integration/editor_preview_ix.ts $VSCODE_CDP_PORT$` |
| Custom styles (CSS files + CSS custom properties) | `bun tests/integration/custom_styles_ix.ts $VSCODE_CDP_PORT$` |
| SALT mockup ranges + anchor guard + empty state | `bun tests/integration/preview_misc_ix.ts $VSCODE_CDP_PORT$` |
| Inspect editor tokens & scopes | `Ctrl+Shift+P` → `Developer: Inspect Editor Tokens and Scopes` (section 3f) |
| Build only the grammar (skip full `npm run compile`) | `npm run build:syntax` (section 5) |
| Launch with a single extension excluded (A/B test) | `vscode_cdp_kill $VSCODE_CDP_PORT$` then call `code` directly with `--disable-extension vue.volar` (section 1) |

## Known Limits of This Setup

- **Dragging the view to the sidebar** is stock VS Code view behavior and is
  not simulated — verify by hand (drag the view header to the Primary/Secondary
  Sidebar; the preview follows the same active document in any container).
- **Bidirectional scroll sync is exercised, not asserted.** The
  preview→editor path (scroll the preview, the editor reveals the line) has no
  stable DOM-level oracle from outside the window, so the test scrolls the
  preview and checks the extension doesn't error rather than asserting editor
  position. The *preview-side* scroll anchoring (reading position survives
  async diagram re-renders) IS covered by `exp/e2e-anchor.cjs` (section 3b).
- **The anchor E2E covers mermaid only.** PlantUML is *not* a
  placeholder-replacement renderer: `jebbs.plantuml` contributes a markdown-it
  plugin (`extendMarkdownIt`) that turns `puml` fences into `<img>` tags
  *inside* `markdown.api.render` — no `markdown.previewScripts` involved, no
  placeholder swap. Its re-render path is the stale-IMG keeper (old img kept
  in flow until the new one loads), which is scenario B of the harness in
  `exp/scroll-anchor-test.html`. See section 3d for rendering puml in the dev
  host. The original scroll-jump bug was reported against puml
  (`tests/samples/enroll-flow-elements.puml.md`) — see
  `docs/issues/bugs/2026/08/03/2026-08-03-scroll-position-jumps-after-diagram-re-render-CLOSED.md`.
- **System-browser opening is not tested on purpose**: opening external links
  would pop the user's real browser. The handler is a thin wrapper around
  `vscode.env.openExternal`.
- **Contributed preview scripts are exercised via mermaid only.** The smoke
  test asserts the mermaid diagram renders and re-renders on live edits
  (checks 7 and 11). Math (KaTeX) is verified by hand: the contributed
  `markdown.previewStyles` (e.g. `katex.min.css`) are loaded now, and the
  engine's markdown-it math plugin runs inside `markdown.api.render`, so math
  renders styled — but there is no automated check for it.
- **Key bindings inside cross-origin iframes** behave like the browser
  project: keystrokes inside a cross-origin page never reach VS Code. The
  preview chrome itself (our own webview) does forward keys.
- **Completions are not in the smoke suite.** The in-markdown PlantUML
  completions (section 3g + 3l) are extension-host language features, outside the
  webview-OOPIF CDP harness; they are covered by the pure-logic
  `plantuml_completion_check.ts` + `plantuml_definition_check.ts`
  (catalog sanity + `procedureNames`) plus a manual dev-host spot-check
  (`Ctrl+Space` / `@` / `!` / `(` inside a puml fence), not by `test_preview.ts`.
  Dynamic procedure alias completions (`SALT`, `_sample_row_empty`) are verified
  by the `procedureNames` pure check (section 3l). An automated assertion would
  need `vscode.executeCompletionItemProvider` from the workbench target (see
  quirks.md).
- **Cursor-sync *media* highlighting (cursor inside a rendered puml fence) is
  not in the smoke suite.** The `data-hmk-from`/`data-hmk-to` span emission is
  pinned by `tests/units/plantuml_check.ts` and `tests/units/mermaid_check.ts` (pure
  logic, no dev host / no server); the smoke suite asserts the generic
  block/paragraph/code-fence highlight (checks 7e) plus the mermaid click-to-
  source echo (7g). Highlighting a live rendered puml `<img>` requires a
  configured PlantUML server on a dedicated host (section 3d/3e).
- The onboarding overlay only appears on **fresh** profiles; once dismissed it
  is persisted and `open_view.ts` becomes a no-op for steps 1.

### Code font fallback & column-width gotchas

Two CSS cascade traps worth documenting:

**1. `code` font-family fallback.** The `markdown.css` rule sets
`font-family: var(--vscode-editor-font-family, "SF Mono", ..., monospace)`.
When `--vscode-editor-font-family` is set (e.g. to `Consolas Nerd Font` on
the Eink 60Hz theme), `var()` substitutes the entire value — the fallback
chain is discarded, and if the named font doesn't exist on the system
(code-server host), the browser falls back to its default (serif, not
monospace).

The fix is twofold:
- Put the variable as the first item in the comma-separated list, not as the
  sole `var()` value: `font-family: var(--vscode-editor-font-family), "SF Mono", ..., monospace`.
- Add `!important` to beat the built-in `markdown-language-features/markdown.css`
  which is injected via `markdown.previewStyles` and also carries the same
  `code { font-family: var(...) }` rule.
- As a permanent insurance, an inline `<style>` tag in `previewHost.ts:buildHtml()`
  repeats the rule with `!important`, so it's always in the HTML regardless of
  external stylesheet loading order.

To verify in a code-server CDP session:
```js
// Measure rendered width vs monospace/serif
const s = getComputedStyle(document.querySelector('#preview p code'));
const el = document.createElement('span');
el.style.fontSize = '72px'; el.textContent = 'mmmmmmmmmmlli';
el.style.fontFamily = s.fontFamily; document.body.appendChild(el);
const w = el.getBoundingClientRect().width;
el.style.fontFamily = 'monospace';
const mono = el.getBoundingClientRect().width;
el.remove();
console.assert(Math.abs(w - mono) < 3, 'code should render monospace');
```

**2. Column-width must not constrain the toolbar.** The `media.css` rule
`body { max-width: var(--hmk-column-width, 100%); margin: 0 auto; }`
constrained the entire `<body>`, including the toolbar. Since the layout is:
```html
<body>
  <div class="toolbar">…</div>
  <div class="markdown-body">…</div>
</body>
```
The `<body>` shrink wrapped everything. Fix: apply `max-width` and
`margin: 0 auto` to `.markdown-body` only, so the toolbar stays full-width.

To verify:
```js
const body = document.body;
const toolbar = document.querySelector('.toolbar');
const content = document.querySelector('.markdown-body');
const bw = body.getBoundingClientRect().width;
const tw = toolbar.getBoundingClientRect().width;
const cw = content.getBoundingClientRect().width;
console.assert(Math.abs(bw - tw) < 1, 'toolbar should be full-width');
console.assert(cw < tw, 'content should be narrower');
```

When working on code-server (browser-based VS Code), use `location.reload()`
via CDP `evaluate_script` to reload the IDE after `make install`. Unlike the
desktop dev host (`Developer: Reload Window`), the browser-level reload is
cleaner and avoids the `beforeunload` dialog from unsaved content.

### Code-server: extension host caching & activation

**Extensions are cached by the service worker.** code-server registers a
Service Worker (logged as `[Service Worker] registered` in the console) that
caches extension JavaScript files. A standard page reload (`F5` or
`location.reload()`) may not invalidate it — the Service Worker intercepts
extension module requests and serves stale cached copies. Even `ignoreCache:
true` on `Navigate` CDP command does not bypass the Service Worker.

To force a fresh load: **bump `package.json#version`** and re-run
`make install`. code-server treats each version as a new extension and loads
its code from scratch. A version bump is the only reliable way to bust the
extension host cache.

**Extension logs go to remoteexthost.log, not the browser console.**
`console.log()` from an extension running in the remote extension host
appears in:
```
~/.local/share/code-server/logs/<timestamp>/exthost<N>/remoteexthost.log
```
Browser DevTools console messages marked `[Extension Host]` are cross-posted
by the VS Code service layer and are NOT the same as raw `console.log()`.
If your `console.log` doesn't appear in either place, it may be suppressed
— write to a temp file instead to confirm code execution:
```js
try { require('fs').writeFileSync('/tmp/hmk-debug.txt', fragment); } catch {}
```

**`markdown.markdownItPlugins` does NOT work in code-server.** code-server
uses a web-worker extension host for built-in extensions (including
`markdown-language-features`), while user extensions run in a REMOTE
extension host (Node.js). The `extendMarkdownIt` function exported from a
remote-host extension is never called by the markdown engine running in the
web-worker host. If you need to modify markdown-it rendering, do it via
post-processing of the fragment returned by `markdown.api.render` — not
via the `markdown.markdownItPlugins` contribution point.

### VLM-assisted webview debugging

When your model lacks vision capabilities, delegate screenshot analysis to a
vision-capable model via the CLI:

```sh
# Take a screenshot of the preview webview inner iframe
node -e "
const CDP = require('cdp');
const target = await CDP.list({ port: 9023 }).find(t => t.title.includes('vscode-webview'));
await CDP.screenshot(target.id, '/tmp/preview.png');
"

# Analyze with a vision model
opencode run -m "opencode-go/muse-spark-1.3-contributor" \
  "Describe the rendered content. Are there any errors?" \
  -f /tmp/preview.png --variant minimal
```

The webview OOPIF iframe can be targeted by its URL pattern
(`vscode-webview://`). To reach the preview inner iframe through the
code-server nested-iframe structure:
```js
// code-server: main page → webview iframe → inner content iframe
const webviewIframe = document.querySelectorAll('iframe.webview')[0];
const innerDoc = webviewIframe.contentDocument
  .querySelector('iframe').contentDocument;
const preview = innerDoc.getElementById('preview');
```

### Running multiple integration tests against code-server

Running more than 3–4 CDP integration tests **sequentially against the same
code-server session** destabilizes the workbench:

- Each test opens files, dispatches palette commands, creates editor tabs —
  the workbench accumulates state (open tabs, webview panels, cursor
  positions) that is never cleaned up.
- The REST-based `tests/integration/*_ix.ts` suites **clean up after
  themselves**: their `finish()` calls `restCleanup()` (see
  [`tests/integration/rest.ts`](../../tests/integration/rest.ts)), which
  discards every dirty editor, closes leftover text tabs (keeping webview
  panels, so the preview survives), and deletes the `/tmp/hmk-*` fixtures.
  Closing a dirty editor uses `workbench.action.revertAndCloseActiveEditor`
  because `tabGroups.close(tab, true)` still pops the "Do you want to save?"
  dialog for a dirty *untitled* doc under code-server.
- `test_preview.ts` does **not** use `restCleanup()` (it does not import the
  REST helper) and remains the main source of leftover tabs.
- After ~6 tests, symptoms include: `connectPreview()` timing out (the
  preview iframe is hidden behind accumulated editor groups), the command
  palette not rendering (`.quick-input-widget` never appears), CDP
  `Runtime.evaluate` calls hanging indefinitely, and the MCP browser tools
  timing out (`Request timed out -32001`).
- A **stuck "Do you want to save?" dialog blocks everything** — REST evals
  time out too. Dismiss it (`Don't Save`) in the browser before continuing.
- The **only reliable recovery** is `docker restart
  vscode-hacker-meta-code-server-1`, wait 15s for the CDP endpoint, open a
  fresh browser tab (`new_page`), close the old one, and re-run
  `open_view.ts`.

**Rules for batch testing via code-server:**

1. Run tests **one at a time**, not as a long sequential `for` loop.
2. Between groups of 3–4 tests, restart code-server and re-run
   `open_view.ts`.
3. After each test, close any editor-area preview tabs it may have created
   (`restCleanup()` already handles the `*_ix.ts` suites; verify manually for
   `test_preview.ts`).
4. If a test hangs (no output for 60s+), the CDP session is likely dead —
   kill the bun process, restart code-server, start fresh.
5. For MCP tool calls (chrome-devtools), prefer `evaluate_script` over
   `navigate`/`reload` — less state churn, no `beforeunload` dialogs.

### Ctrl+S not forwarded by browser CDP (code-server)

In a browser-based code-server session, **`Ctrl+S` is intercepted by the
browser** (Save Page dialog) and never reaches VS Code's keybinding
service. Any test that types text, then sends `Ctrl+S` to trigger a
save-render, will fail on code-server — the save never happens.

Workarounds:
- Run the save-dependent check on a **dev host** (Option B) where Electron
  forwards `Ctrl+S` to VS Code's keybinding service.
- On code-server, mark save-dependent checks as SKIP with a clear message
  (e.g. `code-server — Ctrl+S not reliable via browser CDP`).
- The "typing does NOT re-render" half of `renderOnSave` tests works on
  both topologies (it asserts no change, not a change).

### ConnectPreview returns whichever preview it finds first

`connectPreview()` scans for `.toolbar .doc-name` across all webview
iframes and returns the **first** match. If both a docked view and an
editor-area panel are alive (e.g. after running B8's `Open Preview in
Editor`), the test may attach to the **editor panel** instead of the
docked view.

This matters because:
- The docked view has the `openInEditor` button (`showOpenInEditor: true`);
  the editor panel does not.
- The editor panel's webview may be backgrounded (tab not active) — no
  iframe is rendered until activated, so `pEval` returns null.

**Fix:** Tests that need the docked view specifically should close all
editor preview tabs before connecting (`View: Close All Editors` via
palette, or click the `×` on preview tabs). Tests that just need any
preview should tolerate both topologies.

### Code-server webview tabs are lazily rendered

In code-server, a webview tab that is not the **active tab in its editor
group** has **no iframe in the DOM** — the webview content is disposed to
save memory. This means:

- After `Open Preview in Editor`, the second preview tab exists but its
  iframe is not rendered until clicked/activated.
- Deep-scanning all iframes for `.toolbar` content may find only one
  preview even when two tabs exist.
- To verify an editor-area preview was created, assert on **tab presence**
  (`.tabs-container .tab` text), not on webview DOM content.

### Inline `bun -e` breaks on complex template strings

Running CDP probe code via `bun -e '...'` with template-literal strings
(that contain backticks, `${...}`, or nested quotes) causes
`SyntaxError: missing ) after argument list` in `cdp.ts:71`. The shell
quoting layer mangles the template delimiters.

**Fix:** Write a temporary `.ts` file and run `bun that-file.ts`, or use
the chrome-devtools MCP `evaluate_script` tool (no shell quoting).

### PlantUML server must be reachable from the container

The SVG inlining step (`src/plantuml/inlineSvg.ts`) fetches diagram SVGs
from the **extension host process** — which runs inside the Docker
container for code-server. If the PlantUML server is bound to `127.0.0.1`
on the host (SSH tunnel, `--bind-addr 127.0.0.1`), the container cannot
reach it on a bridge network.

Symptoms (silent):
- Diagrams render as `<img>` in the preview (the **browser** can reach
  the server) but are NOT inlined to `<svg>`.
- `data-source-code` ranges never appear → SALT cursor highlight and
  click-to-source silently don't work.
- The `<img>` renders fine, and no error is logged — the inline fetch
  silently fails and falls back gracefully.

**Fix:** Use `network_mode: host` in the code-server Docker compose, or
bind the PlantUML server to `0.0.0.0`, or configure `hackerMarkdown.plantuml.server`
to point at a host-reachable address.

To verify: `docker exec <container> curl -s -o /dev/null -w "%{http_code}"
http://localhost:9274/svg/SoWkIImgAStDuNBAJrBGjLDmpCbCJbMmLRtS51Gg00`
— should be `200`.

### Mermaid extension highlight override (code-server)

The `mermaidchart.vscode-mermaid-chart` extension (and similar mermaid
extensions) override `options.highlight` on the markdown-it instance via
`extendMarkdownIt`. On code-server, VS Code's built-in syntax highlighter is
absent, so the original `highlight` function is `null`. The fallback path
becomes:
```js
c?.(t, i, r) ?? t   // c = null, so returns raw code text t
```
When the puml source contains `<` characters (salt mockup syntax like
`<b>`, `<&microphone>`), markdown-it treats the return value as rendered
HTML and emits it WITHOUT a `<pre><code>` wrapper. This breaks our
`rewritePumlFences` regex which expects `<pre><code class="language-plantuml">`.

Furthermore, the mermaid extension wraps the content in
`<pre style="all:unset;"><div class="mermaid-chart">@startuml...</div></pre>`.
Our `PUML_UNWRAPPED_REG` fallback regex matches this structure and extracts
only the `@start...@end` portion (stripping the HTML wrapper) before sending
it to the PlantUML server — otherwise the server receives `<div class="mermaid-chart">`
as part of the diagram source and returns a "Syntax Error" SVG.

The current fix in `src/plantuml/fences.ts`:
```typescript
const srcMatch = content.match(/(@start\w+[\s\S]*?@end\w+)/);
const source = srcMatch ? unescapeHtml(srcMatch[1]) : unescapeHtml(content);
```

This applies ONLY to our extension's copy of the fragment — the stock
preview is unaffected (good). The mermaid extension's broken highlight does
not prevent our post-processing from working, as long as the rewrite handles
both the standard `<pre><code>` format and the mermaid-rewritten `<pre>` format.

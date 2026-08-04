# How to Test This Extension

A webview-view extension is hard to test manually because its UI runs inside an
**out-of-process iframe (OOPIF)** that normal browser tooling (DevTools, plain
Playwright) cannot reach, and the extension only exists inside an
**Extension Development Host**. This document describes the exact pipeline we
use to test it end-to-end:

1. Launch a dev host with a CDP port
2. Prepare the workbench: dismiss the one-time onboarding overlay, reveal the
   panel container switcher, click the "Hacker Markdown" tab
3. Reach *inside* the webview OOPIF with a raw CDP client
4. Simulate user actions (trusted CDP input only) and assert on observable state
5. Use the built-in `markdown.api.render` engine + DOM state as ground truth

For the generalized "why is the tool doing this" knowledge (scroll-event
timing, monaco virtualization, CDP keybinding flags, …), see
[`docs/important/quirks.md`](quirks.md). For how the extension is wired up
(source layout, rendering pipeline, pan/zoom frames, image `src` rewriting)
see [`docs/important/architecture.md`](architecture.md).

Test scripts live in [`tests/`](../../tests/):

| Script | Purpose |
| --- | --- |
| `tests/open_view.cjs` | One-shot prep: dismiss overlay, open panel, click the view tab, wait for the OOPIF target |
| `tests/test_preview.cjs` | Full 18-check functional smoke test |
| `tests/cdp_eval.cjs` | Evaluate an expression in the webview OOPIF (debugging) |
| `tests/plantuml_check.cjs` | Pure-logic check of the PlantUML preview rendering (no dev host, no server) |
| `exp/e2e-anchor.cjs` | Scroll-anchor E2E: edit a mermaid block, assert the reading position survives the async re-render |

---

## Prerequisites

- Node.js (for `tests/*.cjs` and `npm run compile`)
- The extension compiled: `npm run compile`
- A local build of VS Code on the `code` CLI

## 1. Launch the Extension Development Host

The extension is NOT loaded in a normal VS Code window. Run it as a dev
extension in its own instance with a debug port:

```sh
cd /Users/lamnt45/git/vscode-hacker-markdown
code --extensionDevelopmentPath="$PWD" \
     --user-data-dir="$PWD/exp/devhost" \
     --remote-debugging-port=9335 \
     --new-window \
     "$PWD/tests/workspace/test.md"
```

(The `Run Extension` launch config from `F5` starts the same host; the
pipeline below just pins the port and fixture explicitly.)

The preview appears in the bottom Panel under the "Hacker Markdown" tab. Drag
its header to the Primary Sidebar if you prefer it there — in a fresh profile,
toggle the panel once with `Cmd+J` so the container switcher appears.

Notes:

- `--user-data-dir` with a fresh profile forces a **separate instance**; without
  it, the window would join an already-running VS Code and ignore the port.
- **No `--disable-extensions`.** The dev host loads the real user extensions,
  which the suite depends on: check 7 (mermaid) requires
  `bierner.markdown-mermaid`, and puml rendering requires `jebbs.plantuml`.
  With `--disable-extensions` both silently degrade (mermaid never renders,
  `Error: Tool "renderMermaidDiagram" was not contributed`; puml stays a plain
  code block). The cost: ~30 extensions activate, startup is slow, and extra
  webview targets appear (Copilot chat, other previewers) — the test helpers
  always find the preview by probing for `.toolbar .doc-name`, never by target
  order.
- Opening `tests/workspace/test.md` as the file argument makes a Markdown editor
  active at startup, so the preview renders immediately.
- The harmless warning `'remote-debugging-port' is not in the list of known
  options` can be ignored. (The CLI prepends its own
  `--remote-debugging-port=9333`; Chromium lets the **last** occurrence win,
  so the window still binds 9335.)

Verify the extension registered:

```sh
curl -s http://127.0.0.1:9335/json/list          # workbench page target
```

or run `Hacker Markdown: Open` / `Hacker Markdown: Open Preview in Editor` /
`Hacker Markdown: Refresh Preview` from the command palette.

## 2. Prepare the Workbench (one-shot)

A fresh dev-host profile needs three manual-ish steps before the preview exists:

```sh
node tests/open_view.cjs 9335
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
node tests/test_preview.cjs 9335
```

The 18 checks (current status: **all passing**):

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

## 3b. Scroll-Anchor E2E (diagram re-render)

The smoke test does not assert scroll positions, so the async-diagram case
(edit a puml/mermaid block → the rendered diagram reloads → does the reading
position survive?) has its own script. It needs the dev host launched with
the fixture document (it edits the mermaid block on a known line):

```sh
pkill -f "extensionDevelopmentPath.*hacker-markdown"
code --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost" \
     --remote-debugging-port=9335 --new-window \
     "$PWD/exp/e2e-anchor.md"
node tests/open_view.cjs 9335
node exp/e2e-anchor.cjs 9335   # PASS: reading position held across mermaid re-render
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

`exp/scroll-anchor-test.html` drives the *real* `media/index.js` in a
plain page (stubbed `acquireVsCodeApi`) to test the stale-diagram keepers
cross-renderer: scenario A is the container pattern (mermaid: placeholder
held at its old height + badge), scenario B is the img pattern (plantuml:
old img kept in flow until the new one loads). It needs two local servers:

```sh
python3 -m http.server 8377 --bind 127.0.0.1 &   # serves the harness + media
node exp/slow-img-server.cjs &                    # 2s-delayed image on 8378
# open http://127.0.0.1:8377/exp/scroll-anchor-test.html in a browser;
# the page title flips to PASS/FAIL and window.__log has the detail.
```

Harness-specific gotchas: it must load `media/main.css` (the badge CSS is
part of the behavior), then override `html, body { height: auto !important }`
after it — main.css's `height: 100%` shrinks the sticky toolbar's
containing block in a plain page and silently breaks every scroll
measurement.

## 3d. PlantUML (puml) diagrams

The dev host renders puml only when *both* hold:

1. Launched **without** `--disable-extensions` — `jebbs.plantuml` must load
   (it contributes `markdown.markdownItPlugins: true` and `extendMarkdownIt`,
   so the plugin runs inside `markdown.api.render`).
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
pkill -f "extensionDevelopmentPath.*hacker-markdown"
code --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost" \
     --remote-debugging-port=9335 --new-window \
     "$PWD/tests/samples/enroll-flow-elements.puml.md"
node tests/open_view.cjs 9335
node exp/probe_all.cjs 9335 "<expr>"   # iterate ALL iframe targets (extra webviews present)
node exp/persist_test.cjs 9335          # zoom -> save -> zoom restored
```

Expected: 12 puml `<img>`s, all wrapped in `.hmk-frame`; zoom-in / Alt+drag
pan / reset work; zoom+pan state survives a save-triggered re-render (the
frame state is keyed by the img `src`, and plantuml URLs encode the diagram
source). Why the framing works: the markdown-it plugin emits the `<img>` as a
*direct child of `#preview`* (block level, no `<p>` wrapper), so
`isFrameable` must not treat block siblings (H2/H3…) as "inline prose" —
the sibling check applies only inside phrasing containers (`p`/`span`/…).
The pan/zoom fixture checks in `tests/test_preview.cjs` (7b–7d) cover the
same behavior on `test.md`'s `<p>`-wrapped image.

## 3e. PlantUML rendering (no jebbs.plantuml required)

`puml` / `plantuml` / `uml` fences render as PlantUML-server SVG images
**without** `jebbs.plantuml` (see `docs/plans/2026/08/04/2026-08-04-plantuml-markdown-preview-rendering.md`
and `docs/important/architecture.md`). The rewrite happens extension-side on
the fragment returned by `markdown.api.render`, so the stock preview is
unaffected. The rendering core (`src/plantuml/{fences,diagram,type,plantumlURL,include}.ts`)
is pure (no `vscode` import) and is unit-checked against the real shipped
`out/` code without a dev host:

```sh
npm run compile
node tests/plantuml_check.cjs   # fence rewrite, svg/png, newpage, escaping round-trip, !include
```

The e2e path (isolated host, a real server) is documented in the plan doc:

```sh
# fresh profile => ONLY this extension loads ("disable all extensions");
# plantuml.server = http://localhost:9274 in exp/devhost-puml settings
pkill -f "extensionDevelopmentPath.*hacker-markdown"
code --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost-puml" \
     --remote-debugging-port=9337 --new-window \
     "$PWD/tests/samples/enroll-flow-elements.puml.md"
node tests/open_view.cjs 9337
# assert: a puml fence rendered an <img> (decoded from the server URL) wrapped in .hmk-frame
```

Also covered by `plantuml_check.cjs`: with `hackerMarkdown.plantuml.server`
empty, a puml fence becomes the `.hmk-puml-error` notice with an *Open
Settings* button (opens the setting via `workbench.action.openSettings`),
instead of an image.

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
npm run compile                    # tsc -> out/
# restart the dev host (kill the old window first):
pkill -f "extensionDevelopmentPath.*hacker-markdown"
code --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost" \
     --remote-debugging-port=9335 --new-window \
     "$PWD/tests/workspace/test.md"
node tests/open_view.cjs 9335
node tests/test_preview.cjs 9335
git checkout -- tests/workspace/sub.md   # the suite saves the live-edit token into the fixture
```

**The suite is not idempotent.** `test_preview.cjs` mutates the dev host
state as it goes (opens files, creates panels, switches editors), so
re-running it against a live host without a fresh launch produces bogus
failures (observed: checks 6/7/11 fail with a stray `scrollIntoView`
TypeError). Always restart the dev host between runs — and before
troubleshooting a failure, re-run once on a fresh host to rule out
contamination. It also **dirties tracked fixtures by design**: the live-edit
check types into `sub.md` and saves it, and any failed palette input leaks
typed text into the open buffer — `git checkout` the fixtures after a run
(`tests/workspace/sub.md`, any sample file you opened).

---

## Quick Reference

| Task | Command |
| --- | --- |
| Start dev host (port 9335) | `code --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost" --remote-debugging-port=9335 --new-window "$PWD/tests/workspace/test.md"` |
| List CDP targets | `curl -s http://127.0.0.1:9335/json/list` |
| Prepare the view | `node tests/open_view.cjs 9335` |
| Full functional smoke test | `node tests/test_preview.cjs 9335` |
| Scroll-anchor E2E (start host with `exp/e2e-anchor.md`) | `node exp/e2e-anchor.cjs 9335` |
| Harness (webview logic; needs ports 8377/8378) | open `http://127.0.0.1:8377/exp/scroll-anchor-test.html` (section 3c) |
| Puml pan/zoom check (start host with `tests/samples/enroll-flow-elements.puml.md`; needs `plantuml.server` in the dev host profile) | `node exp/probe_all.cjs 9335` + `node exp/persist_test.cjs 9335` (section 3d) |
| PlantUML rendering pure-logic check (no dev host) | `node tests/plantuml_check.cjs` (section 3e) |
| Evaluate in webview | `node tests/cdp_eval.cjs 9335 iframe vscode-webview:// "<expr>"` |

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
- The onboarding overlay only appears on **fresh** profiles; once dismissed it
  is persisted and `open_view.cjs` becomes a no-op for steps 1.

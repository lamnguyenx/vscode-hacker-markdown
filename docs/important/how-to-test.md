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

Test scripts live in [`exp/`](../../exp/):

| Script | Purpose |
| --- | --- |
| `exp/open_view.cjs` | One-shot prep: dismiss overlay, open panel, click the view tab, wait for the OOPIF target |
| `exp/test_preview.cjs` | Full 13-check functional smoke test |
| `exp/cdp_eval.cjs` | Evaluate an expression in the webview OOPIF (debugging) |

---

## Prerequisites

- Node.js (for `exp/*.cjs` and `npm run compile`)
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
     --disable-extensions "$PWD/exp/workspace/test.md"
```

Notes:

- `--user-data-dir` with a fresh profile forces a **separate instance**; without
  it, the window would join an already-running VS Code and ignore the port.
- `--disable-extensions` keeps Copilot & co. out of the way; the dev extension
  is still loaded via `--extensionDevelopmentPath`.
- Opening `exp/workspace/test.md` as the file argument makes a Markdown editor
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
node exp/open_view.cjs 9335
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
node exp/test_preview.cjs 9335
```

The 13 checks (current status: **all passing**):

| # | Check | What it proves |
| --- | --- | --- |
| 1 | Initial render: doc-name = `test.md` | Active-editor tracking at startup |
| 2 | Headings rendered | `markdown.api.render` output lands in the DOM |
| 3 | Highlighted code block (`pre code span.hljs-keyword`) | Engine syntax highlighting present |
| 4 | Table rendered | GFM output present |
| 5 | Empty state hidden / preview visible | Initial state is correct |
| 6 | `[data-line]` source markers present | Scroll-sync metadata rendered |
| 7 | Link click opens `sub.md` and preview follows | Relative link resolution + follow-active-editor |
| 8 | `sub.md` content rendered | Second document renders |
| 9 | Live update after typing in the editor | Debounced re-render on document change |
| 10 | Second preview webview created | `Open Preview in Editor` works |
| 11 | Editor panel follows the same document | Shared render controller |
| 12 | Editor panel hides the Open-in-Editor button | Host chrome varies by container type |
| 13 | Empty state for a non-markdown active editor | Empty-state messaging on editor switch |

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
  click is not only unnecessary, it can steal focus and make the live-update
  check flaky.

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
     --remote-debugging-port=9335 --new-window --disable-extensions \
     "$PWD/exp/workspace/test.md"
node exp/open_view.cjs 9335
node exp/test_preview.cjs 9335
```

---

## Quick Reference

| Task | Command |
| --- | --- |
| Start dev host (port 9335) | `code --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost" --remote-debugging-port=9335 --new-window --disable-extensions "$PWD/exp/workspace/test.md"` |
| List CDP targets | `curl -s http://127.0.0.1:9335/json/list` |
| Prepare the view | `node exp/open_view.cjs 9335` |
| Full functional smoke test | `node exp/test_preview.cjs 9335` |
| Evaluate in webview | `node exp/cdp_eval.cjs 9335 iframe vscode-webview:// "<expr>"` |

## Known Limits of This Setup

- **Dragging the view to the sidebar** is stock VS Code view behavior and is
  not simulated — verify by hand (drag the view header to the Primary/Secondary
  Sidebar; the preview follows the same active document in any container).
- **Bidirectional scroll sync is exercised, not asserted.** The
  preview→editor path (scroll the preview, the editor reveals the line) has no
  stable DOM-level oracle from outside the window, so the test scrolls the
  preview and checks the extension doesn't error rather than asserting editor
  position.
- **System-browser opening is not tested on purpose**: opening external links
  would pop the user's real browser. The handler is a thin wrapper around
  `vscode.env.openExternal`.
- **Math / contributed scripts are not exercised**: `markdown.api.render`
  renders math via the engine plugin, but the contributed KaTeX stylesheet is
  not loaded in this wrapper (see README limitations), so there is nothing to
  assert.
- **Key bindings inside cross-origin iframes** behave like the browser
  project: keystrokes inside a cross-origin page never reach VS Code. The
  preview chrome itself (our own webview) does forward keys.
- The onboarding overlay only appears on **fresh** profiles; once dismissed it
  is persisted and `open_view.cjs` becomes a no-op for steps 1.

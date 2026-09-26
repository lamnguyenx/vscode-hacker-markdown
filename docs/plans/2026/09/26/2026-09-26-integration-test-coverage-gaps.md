# Integration test coverage: undocumented features & test gaps

**Date:** 2026-09-26
**Outcome:** 9 new CDP integration test files (39 checks passing, 2 skipped)
+ 1 feature-request issue doc + 1 PlantUML fixture

## What was done

### 1. Code audit — `src/` vs README/features.md

Read every file under `src/` to catalog features implemented in code but
not in the README. Found **19 undocumented features** (A1–A19), documented
in
`docs/issues/feature-requests/2026/09/26/2026-09-26-undocumented-features-and-test-coverage-gaps.md`.

Key finds:
- `!include`/`!includesub` directive resolution with loop detection
  (`src/plantuml/include.ts`)
- `!pragma sourceFile` auto-injection for SALT source ranges
  (`src/plantuml/fences.ts`)
- Multi-page PlantUML diagrams (`newpage`)
- Reading-position anchor guard (pixel-perfect scroll preservation)
- Pan/zoom state persistence keyed by content hash
- Smart pin release on last tab close
- SALT mockup cursor highlight with SVG `vector-effect`
- Contributed `markdown.previewScripts`/`previewStyles` interop
- Code-server mermaid highlight override fallback

### 2. Test coverage gap analysis

Cataloged 12 integration test gaps (B1–B12), with priority ordering from
P0 (7 PlantUML language feature providers + pin lifecycle, both with zero
CDP coverage) to P3 (docs-only).

### 3. Integration tests written

| Test file | Gap | Checks | Key assertions |
| --- | --- | --- | --- |
| `plantuml_render_check.ts` | B1 | 7/7 | Fence → SVG/img, `data-hmk-from`/`data-hmk-to`, multi-page, puml alias, no raw leftover, SVG inlined |
| `plantuml_intellisense_ix.ts` | B2/B3 | 3/3 | Code lens (32 elements, "N references"), folding (10 decorations), F12 go-to-definition (cursor → `!procedure` line) |
| `pin_lifecycle_ix.ts` | B4 | 5/5 | Pin freezes preview, editor switch ignored, unpin follows active editor |
| `media_controls_ix.ts` | B5 | 7/7 | Invert dropdown (off/light), tables (pan/fit), column width input+reset, Escape reverts |
| `link_nav_ix.ts` | B6 | 3/3 | Relative `.md` link preview follows, `#fragment` scrollIntoView works |
| `render_on_save_ix.ts` | B7 | 1+1skip | Typing doesn't re-render (save skipped — browser Ctrl+S) |
| `editor_preview_ix.ts` | B8 | 2/2 | Palette command creates editor tab, multiple webview hosts |
| `custom_styles_ix.ts` | B9 | 6/6 | Core CSS files (main/markdown/highlight/media), CSS custom properties |
| `preview_misc_ix.ts` | B10/B11/B12 | 5+1skip | SALT `data-source-code` (20 mockups), `data-hmk-salts`, `data-hmk-procs`, anchor guard (0px drift) |

Fixture added: `tests/samples/workspace/plantuml-render.md` (3 puml fences
for B1).

---

## Trials, errors & lessons

### Error 1 — Inline `bun -e` with escaped quotes throws SyntaxError

**Symptom:** Running quick probes via `bun -e '...'` with template-literal
strings containing escaped quotes caused `SyntaxError: missing ) after
argument list` in `cdp.ts:71`.

**Root cause:** Bun's `-e` mode wraps the code in a module and the
backtick template strings with nested `'` / `\"` confused the shell
quoting layer.

**Lesson:** For probes longer than one expression, write a temporary
`.ts` file instead of `bun -e`. For CDP evaluation via the chrome-devtools
MCP tools, use `evaluate_script` (no shell quoting layer).

### Error 2 — Tree navigation failed in code-server

**Symptom:** `openFixture()` clicking Explorer twisties to navigate
`tests → samples → workspace → plantuml-render.md` found nothing.

**Root cause:** The tree item `aria-label` matching was fragile —
code-server sometimes renders the label differently than the visible text,
and the twistie geometry varies with theme/zoom level.

**Fix:** Switched to Quick Open (`Ctrl+P` → type filename → Enter). More
robust across both topologies. This is what `test_preview.ts`'s code does
too (via `runPaletteCommand`).

### Error 3 — Media dropdown clicks didn't take effect immediately

**Symptom:** Clicking a dropdown menu item via `.click()` set the value,
but `body[data-invert]` didn't reflect the change within 800ms.

**Root cause:** The dropdown click → `post({ type: 'setMedia' })` →
`config.update()` (async, Global scope) → `onDidChangeConfiguration` →
`mediaState` broadcast. The config round-trip takes 1–3 seconds under
load.

**Fix:** Added `selectMenuItem` helper that polls `body[data-*]` up to 5
seconds instead of fixed `sleep(800)`.

### Error 4 — `openInEditor` button missing from preview

**Symptom:** B8 test found `data-command="openInEditor"` in the preview
toolbar was absent.

**Root cause:** The button only renders on the **docked view** (where
`options.showOpenInEditor === true`). The connected preview was an
**editor-area panel** from a prior session (leftover serialized webview).
The editor panel correctly hides the button. Took significant time to
debug because `connectPreview()` returns the first preview it finds, not
necessarily the docked one.

**Fix for test:** B8 was rewritten to use the command palette
(`Hacker Markdown: Open Preview in Editor`) instead of clicking a button,
and to assert on tab presence rather than webview DOM content (code-server
renders backgrounded webview tabs lazily — no iframe until activated).

**Lesson:** `connectPreview()` connects to whatever preview it finds
first. If both a docked view and an editor panel are alive, the test
may attach to the wrong one. Close all editor panels between tests, or
distinguish by checking `data-command="openInEditor"` existence.

### Error 5 — `network_mode: host` needed for PlantUML server

**Symptom:** B1 initially showed SVGs as `<img>` (not inlined), and B10
found 0 `data-source-code` ranges.

**Root cause:** The code-server Docker container used the default bridge
network. The PlantUML server (`localhost:9274`) was an SSH tunnel bound
to `127.0.0.1` on the host — unreachable from the container's isolated
network namespace.

**Fix:** The user changed the Docker compose to `network_mode: host`,
making `localhost:9274` reachable from inside the container. After
restart, all SVGs inlined correctly.

**Lesson:** Document that `inlineSvg.ts` fetches happen from the
**extension host process** (inside the container for code-server), not
from the browser. If the server is only reachable from the host's
loopback, the container can't reach it. The graceful `<img>` fallback
masks this — diagrams still render (the browser can reach the server)
but SALT cursor/click features silently don't work.

### Error 6 — Browser session hangs / MCP timeout

**Symptom:** During testing, repeated `chrome-devtools` MCP calls
(navigate, evaluate, screenshot) accumulated and eventually all MCP
calls timed out (`Request timed out -32001`). The browser page itself
became unresponsive.

**Root cause:** Rapid sequential navigations + CDP commands without
adequate cleanup left dangling WebSocket connections and pending promises.
The code-server workbench page also destabilizes after 10+ test files
open/close tabs, switch editors, and dispatch palette commands — each
leaves state behind.

**Fix:** `docker restart vscode-hacker-meta-code-server-1`, wait 15s
for CDP port, open a fresh browser tab via `new_page`, close the old one.

**Lesson:** Run integration tests **one at a time** against code-server,
not as a long sequential batch. Each test opens files and creates tabs —
after 6–8 tests the workbench accumulates enough state to destabilize.
If running all tests, restart code-server between groups of 3–4. For
MCP tool calls, prefer `evaluate_script` over navigate/reload when
possible (less state churn).

### Error 7 — `Ctrl+S` intercepted by browser in code-server

**Symptom:** B7's save-triggered re-render check passed the "typing
doesn't re-render" half but never triggered a re-render after save.

**Root cause:** In code-server (browser-based VS Code), `Ctrl+S` is
intercepted by the browser (Save Page dialog) before reaching VS Code.
This is a fundamental limitation of browser-based CDP — trusted key
events for browser-reserved shortcuts don't forward to the web app.

**Fix:** Marked the save check as SKIP with a clear message. The
"no re-render while typing" check still validates the debounce gate.
The save half would pass on a dev host (Electron, no browser
interception).

### Error 8 — Stale VSIX extension shadowed symlink

**Symptom:** `openInEditor` button was absent even after removing stale
editor panels and reloading.

**Root cause:** Two extensions existed side-by-side in the code-server
extensions dir: the symlinked `hacker-markdown` (from the repo working
tree) and a stale VSIX install `lamnguyenx.hacker-markdown-2026.9.6`.
The VSIX version may have been loaded preferentially or caused the view
ID to resolve to a different activation path.

**Fix:** Removed the stale VSIX:
`rm -rf .../extensions/lamnguyenx.hacker-markdown-2026.9.6`, then
restarted code-server.

### Error 9 — Go-to-definition needs viewport visibility for SALT line

**Symptom:** B2/B3's F12 test reported "could not find SALT(form_empty)
line in viewport" — the 307th line in the 535-line file wasn't rendered
by monaco's virtualization.

**Root cause:** Monaco only renders lines in the viewport. `gotoLine(307)`
scrolls the cursor there, but the rendered lines take a moment to catch
up, and evaluating immediately can miss the line.

**Fix:** Increased the wait after `gotoLine` to 2000ms, then check for
visible `SALT(form_empty)` text content in `.view-line` elements. If
found, navigate cursor by word and press F12. If not found in time, SKIP
(with a clear message). When the viewport cooperates, F12 correctly jumps
to `!procedure _form_empty()`.

### Error 10 — Column width Escape test asserted wrong property

**Symptom:** The Escape-revert test checked `--hmk-column-width` CSS
property, but it sometimes showed the typed value (800px) instead of the
committed value (700px).

**Root cause:** The CSS property is updated **live** on `input` events
(before Escape commits or reverts). Checking the CSS property after
Escape is racy — the property may reflect the transient typed value.

**Fix:** Check the `<input>.value` instead — Escape restores the input's
committed value from `persistedValues`, which is stable.

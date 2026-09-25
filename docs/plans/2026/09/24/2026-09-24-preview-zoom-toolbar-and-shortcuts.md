# Plan: preview zoom (toolbar −/+/reset + Ctrl+=/Ctrl+-/Ctrl+0) — with a font-size detour

**Date:** 2026-09-24
**Status:** DONE (verified on the dev host and on code-server via pp's CDP browser)
**Files edited:** `package.json`, `src/previewHost.ts`, `src/previewManager.ts`,
`src/webview/{types,main,menus}.ts`, `src/media/{media,main}.css`, `README.md`,
`docs/important/{features,architecture,how-to-test}.md`

## Goal

Scale the whole preview body — text, headings, tables, images, diagrams — from
the toolbar and the keyboard, browser-zoom style, persisted like the other
media controls (`hackerMarkdown.media.*`).

## The journey (decision log)

The shipped feature is the **third** design of the day; the two earlier ones
shaped it and are recorded here because their dead ends were instructive.

### 1. Font size (built, verified — then removed)

The first ask was "add Font Size settings". Built exactly on the
`media.columnWidth` pattern:

- setting `hackerMarkdown.media.fontSize` (string CSS length, default `""`);
- toolbar input with `placeholder="inherit"` + reset button;
- `--hmk-font-size` var with fallback chain
  `var(--hmk-font-size, var(--markdown-font-size, 14px))` — our value wins
  when set, the built-in `markdown.preview.fontSize` mirror holds otherwise;
- **a line-height guard**: `markdown.css` pins body line-height in **px**
  (`var(--markdown-line-height, 22px)`), so enlarging only the font-size made
  16–20px text visibly cramped (ratio 22/16 ≈ 1.22). The guard emitted
  `--hmk-line-height: 1.5715` (unitless, the stock 22/14 ratio) — but *only*
  when our font-size was set **and** `markdown.preview.lineHeight` was not
  explicitly configured (`config.inspect()` — never clobber the user's own
  lineHeight).

Verified end-to-end on code-server (18px → body 18px, h1 36px via em,
line-height 28.8px ≈ 1.5715 × 18, reset → clean 14px/22px fallback). Then the
user pivoted: *"instead of changing fontsize, simply ... zoom function?"*

### 2. −/+ steppers on font size (designed, never built)

Next ask was steppers + Ctrl/Cmd shortcuts. Settled design: ±1px nudge
clamped 8–36, `Ctrl+0` reset, **preview-focused only** (webview keydown — a
`package.json` keybinding would steal VS Code's window-zoom globally). The
plan also surfaced a live-update gap worth remembering: `--hmk-line-height`
was baked into the static `<html style>` at build time, so setting font-size
live never applied the ratio until a rebuild — the fix would have moved the
lineHeight decision into `mediaState()`. Superseded by the zoom pivot before
implementation.

### 3. Zoom (final)

User's framing: *"with zoom it zoom out reset?"* — browser-style zoom, with
the % readout doubling as the reset (their picks: replace font-size entirely;
±5% steps; % readout is the reset).

Why zoom is the better primitive:

- scales **everything** — PlantUML/mermaid SVGs carry absolute internal
  sizes, a font-size setting could never scale them;
- the px line-height problem disappears — zoom scales line boxes
  geometrically, no guard, no `inspect()` dance, no live-update gap;
- one number, one clamp, one var — less machinery than font-size had.

## Final design

- **Setting** `hackerMarkdown.media.zoom` (number, default 100, 50–200).
- **Host** (`previewHost.ts`): `getZoom()` clamps; `getSettingsOverrideStyles()`
  bakes `--hmk-zoom: <n/100>` onto `<html style>`; toolbar group
  `[− svgZoomOut] [<n>% readout] [+ svgZoomIn]` — the readout is a button
  (`data-command="resetZoom"`, title mentions Ctrl+0); the zoom SVG paths
  are copies of `frames.ts`'s pan/zoom toolbar icons (previewHost is the
  extension host — no import from the webview bundle, duplicate the consts).
- **Manager** (`previewManager.ts`): `mediaState()` broadcasts sanitized
  `zoom`; `setMedia('zoom')` validates numeric 50–200 → Global;
  `resetZoom` command → `setMedia('zoom', '100')`.
- **Webview** (`menus.ts`): `stepZoom(dir)` snaps the current value to the
  nearest 5 (reads `--hmk-zoom`, falls back to the persisted value — works
  from any state), applies locally, posts `setMedia`; `applyZoom(n)` sets the
  property and the readout text/aria-label; `applyMediaState` applies the
  host-truth value. Keyboard: `Ctrl/Cmd + '='|'+'|'-'|'0'` in the document
  keydown handler next to the Escape logic, `preventDefault()` +
  `stopPropagation()` so VS Code's window-zoom and the browser's page-zoom
  never double-fire; preview-focused only by construction (webview keydown).
- **CSS** (`media.css`): `.markdown-body { zoom: var(--hmk-zoom, 1) }` —
  native CSS `zoom` (Chromium-only originally, now standardized and in every
  VS Code webview + code-server browser); layout reflows natively, no
  transform-clipping hacks. **Full-bleed compensation**: the fill-frame rule
  was `width: 100vw`, but Chromium scales `vw` units inside zoomed subtrees,
  so at 150% the frame overflowed — now
  `width: calc(100vw / var(--hmk-zoom, 1))`.
- **Steppers carry `data-zoom-step`, not `data-command`** — the step is
  computed webview-side (the host never knows the rendered size) and the
  generic command path would double-fire a command with an empty id.
- `menus.ts` **keeps** the `LENGTH_INPUTS` / `data-media-input`
  generalization built for font-size — `columnWidth` still uses it; the
  zoom group is separate machinery (no input, just buttons).

## Trials, errors & gotchas

### Dev host (Option B) CDP debugging was a minefield

- **`open_view.cjs` can grab the wrong webview.** It waits for *any*
  `vscode-webview://` iframe target; with a Markdown editor open from
  startup, the **built-in** preview's webview can be that target. Probing it
  showed an empty bootstrap document — no `.toolbar`, no `.markdown-body` —
  and looked exactly like "my extension is broken". Corollary documented in
  how-to-test: the helpers must find the preview by probing for
  `.toolbar .doc-name`, never by target order.
- **The webview OOPIF is a bootstrap frame.** Even on the right target,
  the toolbar is one `contentDocument` hop down
  (`document.querySelector('iframe').contentDocument`) — same gotcha as the
  `d` variable in `tests/integration/test_preview.cjs`, forgotten and re-learned.
- **`vscode.commands.executeCommand` is not reachable from CDP** on the
  workbench page (`vscode is not defined`) — checking code from outside the
  extension host drove keyroundtrips through UI clicks instead.
- A `python websocket-client` CDP attempt died on
  `403 ... --remote-allow-origins` — the dev host doesn't set it; Node's
  built-in `WebSocket` (what `tests/*/*.cjs` use) is the working client.
- Reused-profile sessions left *stale* webview targets from earlier runs
  (documented in how-to-test: wipe the profile or relaunch fresh).

### code-server (Option A) on pp — the pipeline that just worked

Once the environment existed (see
`/home/lamnt45/git/vscode-hacker-meta/docs/important/dev-code-on-nuc-test-on-pp.md`),
driving a real browser beat raw CDP on the dev host hands down: real user
extensions, trusted clicks/keystrokes via MCP tools, screenshots. Gotchas
that cost time the first time:

- **Workspace trust**: a fresh container-restart shows the Restricted Mode
  banner; extensions (ours included) stay inactive until "Restricted Mode"
  in the status bar → **Trust**. Trivial, but it looks like "extension
  failed to load".
- **A code-server webview is NOT an OOPIF CDP target** — `/json/list` shows
  no `vscode-webview://` iframe. The webview is nested iframes *inside the
  workbench page*: find it from the page target by
  `iframe[src*="extensionId=lamnguyenx.hacker-markdown"]` →
  `.contentDocument` → `querySelector('iframe').contentDocument`.
- **No hot reload**: a running code-server caches the loaded extension —
  every rebuild needs `npm run compile` → `hotload code-server` → reload the
  browser tab. Debugging "my change didn't take" was almost always this.
- **Mounted settings leak between sessions**: Global-scope writes land in
  the mounted `…/code-server/User/settings.json` and survive container
  restarts. Day's evidence: a leftover `"hackerMarkdown.media.fontSize": ""`
  after the font-size removal, and a stale `"hackerMarkdown.media.zoom"`-ish
  105% initial readout from an earlier interactive click in the same
  session. Check `grep hackerMarkdown` there when a test run misbehaves.

### Shell-quoting ate three CDP script attempts

Driving CDP via `node -e "…"` from bash collapsed under nested
quotes/backslashes (`data-zoom-step="+1"` selectors especially). Writing the
script to a file (or a heredoc) fixed it; `Runtime.callFunctionOn` without
an `objectId`/`executionContextId` also fails — just use
`Runtime.evaluate` on the target with the iframe-dive inline.

## Lessons learnt

1. **Ask what the user actually wants before building the plan's first
   interpretation.** "Font size" → the real want was "scale the preview".
   Zoom delivers it with less machinery (no line-height guard, no unit
   juggling, no live-bake gap). The font-size build wasn't wasted — it
   generalized `menus.ts` controls and pinned the Code-server test pipeline.
2. **px line-heights break font-size scaling.** Anyone re-adding font-size
   must either ship the unitless ratio guard or set line-height in em/rem —
   markdown.css's `var(--markdown-line-height, 22px)` is the trap.
3. **`zoom` scales `vw` inside the zoomed subtree** (Chromium) — any
   full-bleed rule that mixes `zoom` with viewport units needs a
   `calc(100vw / var(--zoom))` compensation.
4. **Find webviews by content probe, never by target order** — true on both
   environments (`.toolbar .doc-name` on the dev host,
   `extensionId=` in the iframe src on code-server).
5. **Persisted user settings are test state.** Global-scope `update()` calls
   outlive the session (both dev-host profile and mounted code-server
   settings); clean them between runs or "haunted" values (the 105%) appear.
6. **Interactive-browser testing (Option A) is the better default for UI
   features**; the dev host remains the home of the automated suite. This
   split — and the ask-first rule — is now documented in how-to-test.md.

## Verification (final state)

- `npm run compile` clean (tsc ×2 + esbuild).
- Dev host: `open_view.cjs` + `test_preview.cjs` — all pre-existing passing
  checks still pass (mermaid checks fail as always under
  `--disable-extensions` — unrelated).
- code-server via pp (CDP 9024), the pipeline from how-to-test Option A:
  steppers step in ±5 increments and clamp at 50/200; readout tracks;
  readout click resets to 100%; `--hmk-zoom` and the computed
  `.markdown-body` zoom stay in sync (1 → 1.05 → 1.1 → 1.0); persistence
  lands in the mounted user settings; full tube (click → local apply →
  `setMedia` → Global write → `mediaState` broadcast → `applyMediaState`)
  exercised live.

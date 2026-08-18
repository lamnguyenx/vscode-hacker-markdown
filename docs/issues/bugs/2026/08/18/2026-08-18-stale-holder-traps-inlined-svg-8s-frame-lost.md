# Bug: `.hmk-stale-holder` traps an inlined PlantUML SVG for 8s — pan/zoom frame lost

**Status:** CLOSED (fixed 2026-08-18)
**Affected:** `src/webview/stale.ts` (webview bundle → `build/index.js`)
**Severity:** high (preview feels stuck for ~5-8s after every diagram save; zoom/pan controls vanish)

## Summary

Since commit `3a7a14f` (inlined PlantUML SVGs for salt cursor-sync), editing and
saving a document with a rendered `puml`/`plantuml`/`uml` diagram made the
preview feel broken for several seconds: the diagram got wrapped in a
`.hmk-stale-holder` (a min-height "re-rendering" wrapper, badge included) that
**persisted for 8 seconds**, and for those 8 seconds the pan/zoom frame
(`.hmk-frame`) was **gone** — zoom, pan and the frame's persisted state were
dead until the holder finally unwrapped and a frame re-appeared.

Reproduced with `tests/samples/enroll-flow.puml.md` (1 activity diagram, 15
SALT mockups, 213 KB inlined SVG) on the dev host. The render pipeline itself
was fast — the delay was purely the webview's stale-holder.

## Root cause

`snapshotStaleBlocks` (`src/webview/stale.ts`) was extended in `3a7a14f` to
treat inline `<svg>` elements as stale blocks (previously only `<img>` or
containers *containing* `svg, img`):

```diff
- else if (child.tagName === 'IMG' || child.querySelector('svg, img')) {
+ else if (child.tagName === 'IMG' || child.tagName.toUpperCase() === 'SVG' || child.querySelector('svg, img')) {
```

On the next render/save, the old bare `<svg>` and the new fragment's `<svg>`
occupy the same anonymous block position, so `keepStaleBlocks` paired them and
routed them into `holdPlaceholderHeight` (the **container** keeper). That
function's contract is: *wrap the placeholder in a min-height holder and wait
for the renderer to replace it* — it watches the holder with a
`MutationObserver` and unwraps only when `svg`/`img` content appears **after**
the holder is created.

An inlined PlantUML SVG is **already fully rendered in the fragment** — there
is no placeholder and no late mutation. The observer never fired, so the only
exit was the hard `setTimeout(finish, 8000)` fallback. For those 8 seconds:

- the new diagram sat inside `.hmk-stale-holder` (min-height = old diagram
  height, 4695px in the sample),
- `isFrameable` (`src/webview/frames.ts`) excludes anything inside
  `.hmk-stale-holder`, so the frame scan never wrapped the diagram → **no
  pan/zoom, frame state lost**,
- the whole thing only resolved when the 8s fallback unwrapped the holder,
  whose mutation then re-triggered `scheduleFrameScan` → frame finally back.

The container-hold is only correct for renderers that empty their placeholder
and fill it asynchronously (mermaid/KaTeX). Already-rendered media needs no
hold at all — the new block's own height replaces the old one instantly.

## Fix (`src/webview/stale.ts`)

- **`keepStaleBlocks` skips the container-hold when the new block already
  carries its rendered content.** New helper
  `carriesRenderedContent(el)` = `el.matches('svg, img')` or contains
  `svg, img`. An inlined `<svg>` (or a raw `<img>` from a renderer that emits
  the tag directly) is left in flow — its height replaces the old block's, so
  there is nothing to hold and no layout jump to guard against.
- **`holdPlaceholderHeight` hardened against pre-filled holders.** If the
  holder already contains `svg`/`img` at creation time, unwrap after a short
  120ms badge delay instead of the 8s fallback. This is a defensive backstop
  for any future caller that reaches the container path with content already
  present.

The `<img>` keeper (`keepStaleImg`, holds the old image while a slow new image
URL loads) and the mermaid/KaTeX container hold are unchanged — both still
apply where a real placeholder/async load exists.

## Verification

Measured on the dev host against `enroll-flow.puml.md` (213 KB inlined SVG),
driving real edits + `Ctrl+S` via `xdotool`:

| Metric | Before | After |
|---|---|---|
| `.hmk-stale-holder` present after refresh/save | **~8s** | 0 |
| `.hmk-frame` present after refresh/save | **0 for ~8s** | 1 (immediately) |
| save → new SVG visible in preview | ~140-460ms | ~140-460ms (unchanged) |
| DOM settle after render | 575ms+ | 52-105ms |

- `stale-timing.cjs` (poll every 400ms for 12s after refresh): stale=1/frames=0
  for 8.4s before; stale=0/frames=1 for the whole window after.
- `save-timing.cjs` (3 save rounds): stale=0, frames=1 every round.
- Pure-logic suites: `plantuml_check`, `plantuml_inline_check`,
  `mermaid_check`, `plantuml_completion_check` all pass.
- Full CDP smoke suite: **20/21** checks pass (the 1 failure is the flaky
  command-palette input step on the headless box, unrelated to this change).
- Mermaid container-hold still works: mermaid placeholders are empty at swap
  time (no `svg`/`img`), so they still get held until the async render fills
  them.

## Trials and errors

- **Suspect #1 — the PlantUML server was slow.** The new pipeline fetches each
  diagram SVG in the extension host on every render. Measured the docker
  server (`plantuml/plantuml-server:jetty`, port 9274) at **37ms** per request;
  the extension-host pipeline (markdown.api.render + rewrite + fetch + inline)
  at ~60ms. Not the bottleneck.
- **Suspect #2 — the webview render was slow.** Timed the refresh path from the
  webview: click → render message ~60ms, DOM swap ~immediately, settle ~700ms.
  Content updated fast.
- **The real culprit surfaced only when measuring DOM state over time**: a
  refresh/save left `stale:1, frames:0` persisting for the full 8s window. The
  mutation timeline showed a single swap mutation and then *silence* — the
  container-hold observer was waiting for a mutation that by construction
  never comes for inlined SVGs.

### Test-infrastructure notes (same session)

- The dev host **restores the previous session's dirty buffer** (VS Code hot
  exit) when the profile is reused — the editor appeared to contain old junk,
  breaking edit/save automation. Fix: `files.hotExit: "off"` in a fresh
  profile, or clear `exp/devhost/Backups`.
- CDP `Input.insertText` / `Input.dispatchKeyEvent` do **not** reach Monaco's
  hidden textarea reliably on this box; real `xdotool` input (windowactivate
  --sync + click + type) does. CDP clicks before typing also break the input
  channel.
- Monaco's textarea `.value` stays empty (it's an input sink) — checking it is
  useless; the real buffer is in the editor model, visible via
  `.monaco-editor .view-lines .view-line` text.
- A token typed into the middle of a puml fence renders **inside the SVG**, not
  as markdown text — the "preview updated" check must compare the SVG's
  `outerHTML` length/hash, not `textContent.includes(token)`.
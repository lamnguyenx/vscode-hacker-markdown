# Plan: keep the old diagram visible while it re-renders (no more collapse flicker)

**Date:** 2026-08-03
**Status:** DONE (verified)
**Bug being fixed:** `docs/issues/bugs/2026/08/03/2026-08-03-scroll-position-jumps-after-diagram-re-render-CLOSED.md`
**Files:** `media/index.js` (+~135), `media/main.css` (+41), `src/previewHost.ts` (+cache-busting)

## Goal

When a puml/mermaid/KaTeX diagram re-renders (edit + save), its space
collapses to the empty placeholder and then grows back, pushing the content
below up and down. The user asked: keep the **old diagram visible** with a
"Re-rendering…" overlay until the new render is done, then swap it in — no
up/down jumping.

The scroll-anchor guard (previous fix) already restores the *final* reading
position; this work removes the *intermediate* flicker.

## What the renderers actually do (read from installed extension sources)

Three different patterns exist, and each dictates a different keeper:

| Renderer | Placeholder | Replacement behavior |
| --- | --- | --- |
| jebbs.plantuml (the reported puml case) | `<img src="http://127.0.0.1:PORT/…">` in the fragment | Nothing async — the img element loads the new URL; **the img collapses to 0 height while the request is pending** |
| Built-in VS Code mermaid (active in the dev host) | `pre.mermaid` with `style="all: unset"` | `renderMermaidBlocksInElement` first **removes** `.mermaid > svg`, then `renderMermaidElement` sets `innerHTML = ""` and **writes the new svg back into the same pre** — collapse window between clear and fill |
| bierner.markdown-mermaid | `div.mermaid-wrapper` | `replaceWith` a new `div.mermaid`, then renders into it |

Two renderer behaviors that shape the design:

- **`mermaidContainer.textContent` is the diagram source.** The built-in
  renderer reads the container's text as the mermaid source. Anything we
  put *inside* the placeholder as a real DOM node corrupts the source.
  → the "Re-rendering" badge must be a CSS **pseudo-element** (`::after`),
  which is invisible to `textContent`.
- **Renderers replace (or empty) the placeholder element itself.** A
  `min-height` set on the placeholder dies with it.
  → the height hold must live on a **wrapper div** that survives the
  replacement.

## Design

Two keeper strategies, matched automatically per old/new block:

1. **img ↔ img** (`keepStaleImg`): keep the *old* `<img>` in-flow (faded,
   `.hmk-stale-media`) inside a small holder with the badge, inserted right
   before the new img. The old img occupies the diagram's space until the
   new img finishes loading (`img.complete` poll, 8s deadline), then the
   holder is removed and the new img slides into place. Layout never
   collapses; the net shift is just the height *difference*.
2. **container ↔ container** (`holdPlaceholderHeight`): wrap the new
   placeholder in a `div.hmk-stale-holder` with `min-height: <old height>`
   and the badge (`::after`). When the renderer replaces/fills the
   placeholder, the wrapper still occupies the old height. A
   `MutationObserver` on the wrapper notices the new `svg`/`img`, waits
   120ms (so the badge is perceivable even for sub-16ms renders), then
   **unwraps** (replaces the wrapper with its children — no leftover divs
   to confuse the next render's snapshot). 8s deadline in case the render
   errors out.

**Matching old → new (renderer-agnostic):** both old and new anonymous
(non-`data-line`) blocks are indexed by
`gapIndex` = number of `data-line` elements before them, plus their
`gapOrder` within the gap. This is stable across edits — crucial because
edits *shift the `data-line` values themselves*. Only same-kind pairs
(img↔img, container↔container) are kept; a kind switch means the old
element is not this placeholder's previous render (and holding an img in a
min-height wrapper would never settle).

The badge shows "Re-rendering…" (pseudo-element, `pointer-events: none`,
top-right pill). Imgs additionally fade to 60% opacity while stale.

## The struggle (chronological)

The feature took a long, wrong road. Every dead end is below; each was
proven wrong by measurement before being discarded.

1. **Harness CSS missing → phantom layout shifts.** The harness
   (`exp/scroll-anchor-test.html`) loaded only `media/index.js`, not
   `media/main.css`, so the badge's `position: absolute` never applied —
   the badge took ~17px in flow, and "the note moved" by exactly that.
   Fix: load the real `main.css` in the harness.
2. **`main.css`'s `html, body { height: 100% }` breaks `position: sticky`
   in a plain page.** The sticky toolbar's containing block shrank to the
   viewport, so it stuck to the *bottom* of its box — which silently
   changed every scroll measurement (the anchor line was computed from a
   filler near the top, the page jumped to scrollY≈174). The real webview
   is unaffected; the harness needs `height: auto !important` after the
   main.css link.
3. **The outer-vs-inner window probe trap (biggest time sink).** The
   webview's HTML runs in the *inner* iframe; my probes evaluated in the
   *outer* OOPIF frame and read `window.__hmkVersion` (outer) instead of
   `contentWindow.__hmkVersion` (inner). The marker was always there; I
   spent multiple cycles believing the webview served a stale `index.js`
   and "fixed" caching that was never broken. (The caching fix was still
   worth doing — see below.)
4. **The webview really does cache media — but via mtime busting it's
   fine.** The resource server + service worker (ETag revalidation) can
   serve stale `index.js` across restarts. `previewHost.ts` now mtime-busts
   *all* media URLs (`cacheBustMedia`), not just user styles.
5. **`offsetHeight` is 0 for the mermaid pre.** `style="all: unset"` makes
   it `display: inline`; `offsetHeight` of an inline element is 0, so the
   snapshot's height filter silently skipped the diagram. Use
   `getBoundingClientRect().height`.
6. **Edits shift `data-line` values → value-based gap matching broke.** The
   old diagram sat between lines 11 and 20; after inserting a node, the new
   placeholder sat between 11 and 21. Matched nothing. Fix: positional
   `gapIndex`/`gapOrder` matching (count of preceding data-lines).
7. **Min-height on the placeholder dies with it.** The mermaid renderer
   replaces the pre (or clears it), so the hold must be on a wrapper.
8. **A real badge corrupts the mermaid source.** `textContent` is the
   source; the badge became part of the diagram → "Parse error".
   → pseudo-element.
9. **The "15s render delay" was a 16ms window, not a delay.** The render
   fires 330ms after save and the keeper works; the test's 100ms poll just
   missed the holder (a tiny diagram re-renders in <16ms). Tightened the
   poll to 15ms and gave the badge a 120ms minimum life so it is actually
   perceivable.
10. **Kind-mismatch pairs hang.** After the container scenario, the leftover
    pre (container) matched the next scenario's img; `holdPlaceholderHeight`
    on an img never settles (imgs have no svg to observe). Only pair
    same-kind blocks.
11. **Cross-scenario pollution from leftover holders.** The holder unwrap
    must remove the wrapper entirely, not just clear its class, or the next
    snapshot treats it as a diagram.
12. **Session restore strikes again.** The dev host's restored buffer can be
    corrupted (a stray edit swallowed the mermaid fence, making the whole
    rest of the doc the diagram source) — wipe
    `User/workspaceStorage/*/backups` between verification runs.

## Verification

- Harness (`exp/scroll-anchor-test.html`, real `index.js`, both renderer
  patterns + slow-img server on 8378): PASS — position held to ±0.2px
  (container) / ±11px line-box artifact (img, vs a ~300px collapse without
  the keeper), badge cleaned, holder unwrapped.
- Dev-host E2E (`exp/e2e-anchor.cjs`, real built-in mermaid): badge seen
  400ms after save, no upward collapse while the diagram grows, final
  position restored to ±0.25px, badge gone — PASS.
- Full CDP smoke suite: 15/15 PASS.

## Follow-ups

- The KaTeX case (inline math, small) is covered by the container holder
  but never exercised in a test.
- The badge text "Re-rendering…" is hard-coded in CSS `content`; a
  localized/spinner variant would be a trivial change.

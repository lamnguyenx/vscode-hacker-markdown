# Bug: preview jumps to a wrong scroll position when an edited diagram re-renders

**Status:** CLOSED (fixed 2026-08-03)
**Affected:** `media/index.js`, `media/main.css`
**Severity:** medium (annoying UX regression, no data loss)

## Summary

Editing a `puml` (or `mermaid`/KaTeX) block in the Markdown source and saving
caused the preview to lose the reading position: the rendered diagram
"reloads" (placeholder collapses → async render → grows back), and after the
dust settles the scroll position is off — in the worst case by the full
diagram height, so the paragraph the user was reading is gone from the
viewport.

Reproduced with `tests/samples/enroll-flow-elements.puml.md` (a document of
`@startsalt` puml diagrams with headings/notes between them).

## Root cause

Two cooperating problems in `media/index.js`:

1. **The anchor restore ran before the async diagram render.** `render()`
   remembered the topmost visible line, swapped the DOM, called
   `scrollToLine(anchorLine)` **synchronously**, and only *then* fired
   `vscode.markdown.updateContent`. Diagram renderers (mermaid/puml/KaTeX via
   contributed `markdown.previewScripts`) replace their placeholder element
   asynchronously afterwards, growing the layout *after* the anchor scroll —
   the reading position below the diagram was pushed out of view with nothing
   to re-anchor it.
2. **Chrome's native scroll anchoring cannot save this case.** `overflow-anchor`
   is a browser feature that keeps the visible content stable when layout
   changes — but it explicitly gives up when the anchored node itself is
   removed, which is exactly what diagram renderers do when they replace the
   placeholder. And when it *does* fire (during the collapse), it fights any
   position-restore logic that reads `scrollY` as ground truth.

## Fix

- **Record the ground truth before the swap.** `render()` now captures the
  viewport positions of the topmost visible line *and the line after it* from
  the **old DOM, before** `innerHTML` is replaced. The reading position must
  return to *exactly where it was pre-edit* — not to the transient collapsed
  layout.
- **Anchor guard.** A short-lived `MutationObserver` on the preview that, while
  the diagram renders, restores the anchored line to its recorded position
  whenever it drifts > 4px. If the anchor element was replaced (the common
  renderer pattern), the anchor falls through to the next `data-line` element,
  which is re-found by line number.
- **Never fights the user.** The guard cancels on any scroll it did not
  perform (position mismatch or a scroll event with the programmatic flag
  clear), after two stable settles, or after 3s of quiescence (extended while
  mutations keep arriving, hard cap 10s for slow server-rendered diagrams).
- **`overflow-anchor: none`** in `media/main.css` so the browser's own
  anchoring cannot adjust `scrollY` behind the guard's back.

Files: `media/index.js` (render/keepAnchor/settleAnchor, ~140 lines), `media/main.css` (+3).

## Verification

- Isolated harness (`exp/scroll-anchor-test.html` — loads the real
  `index.js` with a stubbed `acquireVsCodeApi`): reading position held to
  ±0.2px; a no-guard control loses it by the full diagram height; a
  user-scroll scenario proves the guard yields instead of yanking back.
- Real E2E against the dev host (`exp/e2e-anchor.cjs`): edited the mermaid
  block, the diagram grew 165→243px, the note below it drifted **0.45px**.
- Full CDP smoke suite: 15/15 checks pass.

## Trials and errors

Chronological log of the failed approaches (each was proven wrong by
measurement before being discarded):

| # | Approach | What was measured / observed | Why it failed |
| --- | --- | --- | --- |
| 1 | Re-apply `scrollToLine` (block `'nearest'`) from a `MutationObserver` after the diagram render | Note below diagram ended at 166px vs 110px original — 56px drift | `'nearest'` only guarantees *visibility* (aligns to the nearest viewport edge), not *position*. An element below the fold aligns to the viewport bottom; above the fold to the top — the two restore paths disagree. |
| 2 | Exact restore: `scrollBy` to the recorded viewport top, with a 120ms `programmaticScroll` flag window | User-scroll scenario failed: user wheeled during the window, next settle (250ms) yanked the view back | The 120ms time window misattributes a user scroll that lands inside it. Time-based flags are a race. |
| 3 | Consume the flag on the first scroll event instead of a timer | Still failed the user-scroll scenario: the user's `scrollBy(+40)` was reverted | **Chrome coalesces scroll events.** `scrollBy` updates `window.scrollY` synchronously but the scroll *event* fires a frame later; two scrolls in one frame produce ONE event, which consumed the flag — the guard never saw the user's scroll. |
| 4 | Cancel the guard when `scrollY` moved > 4px from the last position the guard set | User-scroll scenario now passed — but the real dev host regressed: no restore at all, note drifted the full 78px diagram growth | **Chrome's scroll anchoring** (enabled by default) adjusts `scrollY` during the DOM swap; the guard misread that as a user scroll and cancelled itself. |
| 5 | Measure drift in document space (`rect.top + scrollY`), immune to scrolls | Harness now failed *only because the browser window had been resized* — viewport 1164px tall, doc too short to scroll, so the anchor was a filler line above the diagram (a stable element — nothing to restore). Resized viewport to 206px, diagram at viewport top: the guard restored the note to 110px — **but it had been at 339px before the edit** | The guard's targets were recorded from the *post-swap* (collapsed) layout. The collapse itself had already moved everything below the diagram up by ~the diagram height. Restoring to the collapsed layout is still a jump — the reading position must be restored to the **pre-edit** layout. |
| 6 | **Record the expected positions from the OLD DOM, before the swap** | Note returned to 339.0→339.2px (±0.2). E2E on the dev host: 0.45px drift while the diagram grew 78px. 15/15 suite | ✅ shipped |

### Test-infrastructure trials (same session)

- `file://` URLs are unique origins — a harness page cannot `<script src>` a
  sibling file, so the harness had to be served over `http://127.0.0.1:8377`.
- The harness must set `overflow-anchor: none` too, or Chrome's anchoring
  silently absorbs the layout shifts the guard is supposed to handle, making
  measurements lie.
- Browser/Chrome restart resets the viewport size: geometry-dependent
  harnesses must explicitly resize the page (`innerHeight` changed 206 →
  1164px between runs, silently breaking the scroll scenario via clamping).
- Monaco only renders visible lines (virtualization): a line in the editor
  DOM doesn't exist until scrolled into view; wheel-scroll + poll for the
  line's element.
- VS Code session restore: re-launching the dev host restores the previous
  cursor position and open files — tests must not assume a pristine cursor.
  `Ctrl+G` (Go to Line) with proper CDP modifier flags is deterministic;
  mouse clicks on the exact line are the alternative.
- Inserting text at the *start* of a mermaid line corrupted the diagram
  (fence stayed intact, the line content merged) — `End` first, then insert.
- `.find(x => textContent.includes('reading position'))` matched the *wrong*
  element ("...the diagram to anchor the reading position against", line 10,
  vs the actual note on line 23) — partial-text matches need a unique
  substring.
- The 15-check suite is **not idempotent**: re-running it against a live dev
  host without a fresh launch fails checks 6/7/11 with a bogus
  `scrollIntoView` TypeError — always restart the dev host between runs.

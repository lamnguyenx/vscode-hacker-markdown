# Fix: wide tables clip text in a narrow preview (fit mode)

**Date:** 2026-11-04
**Status:** DONE (verified: pure-logic units 5/5, `narrow_table_ix` 11/11,
`media_controls_ix` 7/7, `test_preview` 13/15 — the two failures are the known
cursor-sync/keyboard flakes under browser CDP; `make info` reports
`hacker-markdown 2026.11.5 · current`)
**Source:** user report — "test the extension when the viewport of the markdown
is narrow; seems that in that case table will lose some text".
**Files added:** `tests/integration/narrow_table_ix.ts`
**Files edited:** `src/media/media.css`, `package.json` (version),
`tests/integration/cdp.ts`, `tests/integration/open_view.ts`,
`tests/integration/test_preview.ts`, `tests/integration/editor_preview_ix.ts`,
`README.md`, `docs/important/internals/architecture.md, docs/important/features/all-features.md, docs/important/testing/how-to-test.md, docs/important/internals/quirks.md`

## Goal

Find out whether tables really lose text when the preview is docked in a narrow
sidebar/panel, fix it if so, and pin the behavior with a regression test.

## Symptom & reproduction

The fixture is the user's real-world table
(`tests/samples/long-table-fail-02.md`): six columns whose cells contain long
unbreakable tokens — inline code and paths such as
`qnn/zipformer_qnn_conversion.ipynb`, `qairt-converter`,
`qnn-context-binary-generator`.

Open the preview on it (code-server in Docker, CDP 9324), then shrink the
workbench page with `Emulation.setDeviceMetricsOverride({width: 500})` so the
preview pane reflows exactly as it would on a sash drag. Measured at a ~300px
preview:

| mode | table box | reading column right | result |
| --- | --- | --- | --- |
| **pan** (default) | 233px, `scrollWidth` 1501 | 259px | own horizontal scroll region; `scrollLeft = 1268` brings the last cells fully into view — no text lost |
| **fit** | **833px** | 259px | sticks out; `body { overflow-x: hidden }` clips it at the page edge; last column ("Compiler toolchain") sits at x=859 — unreachable |

So the bug is **fit-mode only**. Pan mode was already correct (it just needs a
gesture most users don't discover — see lessons).

Negative control: deleting only the new `overflow-wrap` rule via CSSOM made the
table jump from `right = 259` back to `right = 859` while the viewport stayed
300px, so the measurement really is sensitive to the fix.

## Root cause

A native table cannot be narrower than its **min-content width**: the sum of
each column's longest unbreakable token plus cell padding. `long-table-fail-02`
has an 833px min-content width. In fit mode the table therefore stayed 833px
wide inside a ~280px reading column; the body's `overflow-x: hidden`
(`src/media/main.css`) clipped everything past the page edge, and because the
body is not a user-scrollable container there was no way to reach the missing
columns.

`overflow-wrap: break-word` does **not** help here: it breaks overflowing words
at paint time but does not reduce min-content, so table layout still allocates
833px. `overflow-wrap: anywhere` is the property that participates in
min-content calculation.

## Fix (`src/media/media.css`)

```css
/* fit mode: make wrapping able to shrink the table … */
body[data-tables="fit"] .markdown-body table {
	display: block;
	overflow-x: auto;
	width: fit-content;
	max-width: 100%;
}
body[data-tables="fit"] .markdown-body table td,
body[data-tables="fit"] .markdown-body table th {
	overflow-wrap: anywhere;
}
```

- `overflow-wrap: anywhere` on cells lets long code/URL/path tokens break, so
  the table's min-content collapses to the column and every cell stays visible.
- `display: block` makes the `<table>` itself a scroll container (anonymous
  table boxes still lay the rows out as a grid). This is a **fallback** for the
  cases where even wrapping cannot fit: at 200% zoom the six cells' 20px
  horizontal padding alone exceeds the column, so the table scrolls internally
  instead of being clipped by the page.
- `width: fit-content` keeps small tables at their natural width instead of
  stretching every fit-mode table to full width (verified: the fixture's
  3-column table stays 462px both before and after the change).
- Pan mode is untouched: cells stay `white-space: nowrap` and the table pans.

## Trials, errors and dead ends

1. **`open_view.ts` timed out with `PREVIEW_TIMEOUT` while the preview was
   visibly open.** A stray `chrome://newtab` target was the first CDP `page`
   target; `connectPreview()` and `open_view.ts` picked pages by order and drove
   the wrong tab. Fixed with `openWorkbenchPage()` in `tests/integration/cdp.ts`
   (probe every page for `.monaco-workbench`, never trust order) and made
   `open_view.ts` prefer the REST command with the palette as a fallback. This
   is the playbook's "find the view by a stable app anchor, never by target
   order" rule applied to the *page* itself.
2. **First fix (`overflow-wrap: anywhere` only) solved clipping but looked
   awful at 320px.** With six columns in ~260px each column collapsed to 4–7
   characters ("Pipelin e"). That is inherent to fitting a 6-column table into
   a phone-sized column, not a bug in the rule; pan mode remains the escape
   hatch. The `display:block` fallback above was added later for the
   padding-floor case, not to change the normal layout.
3. **`overflow-wrap: break-word` was tested and rejected** — same visual intent,
   but it does not affect min-content, so the table stayed 833px wide and was
   still clipped.
4. **GitHub-style `display:block; overflow-x:auto` alone was tested and
   rejected as the primary behavior.** It keeps natural column widths, but the
   preview's overlay scrollbars did not render a bar (Chromium under the
   harness), so the table looked exactly like the reported "lost text" until
   the user scrolled. Styling `table::-webkit-scrollbar` did not force a visible
   bar either. Fit mode must therefore *fit*; pan mode is the scrolling mode.
5. **`overflow-x: auto` on the table without `display: block` was checked.**
   Chromium ignores overflow on a `display: table` box (computed `overflow-x`
   stayed `visible`), so it is not a usable fallback.
6. **`table-layout: fixed` was considered.** It equalizes columns based on the
   first row and still shreds long words; it would not preserve natural column
   widths and does not remove the padding floor.
7. **The scroll-wheel probe misled us for a while.** Trusted CDP
   `Input.dispatchMouseEvent` wheel events landed on the table
   (`target: TH`) but never changed `scrollLeft`; a plain `<div>` in the same
   page and even a div in the top-level workbench behaved the same. Conclusion:
   this harness cannot exercise wheel *default actions* (nested same-origin
   iframes in a virtual desktop). Pan-mode correctness was verified with
   programmatic `scrollLeft` instead, which is the right level for this
   property (the container scrolls and the last cell lands inside it).
8. **Zoom exposed a second edge case.** At 200% zoom `overflow-wrap: anywhere`
   still clipped: the six cells' horizontal padding (20px each) is already a
   hard floor larger than the column. That is why the fix also makes the table
   an internal scroll region (`display:block`), instead of pretending wrapping
   can always fit. A regression check at 200% asserts "scrolls, not clipped".
9. **The test initially forced the viewport by writing `iframe.style.width`.**
   VS Code's webview host owns that inline style and reset it back to the pane
   width; clearing it left the iframe at the UA default 300px, corrupting the
   preview layout for the next suite. Replaced with page-level
   `Emulation.setDeviceMetricsOverride` (the workbench reflows its own panes)
   and a plain `clearDeviceMetricsOverride` restore.
10. **`editor_preview_ix` failed mid-run with a `contentDocument` TypeError,
    then `NO_PREVIEW`.** After many suites the workbench had two preview
    panels, one of them without a loaded iframe; the suite is not idempotent.
    A clean harness restart made it 2/2, confirming it was accumulated state,
    not the helper change. Related: `showTextDocument` eventually stalled for
    every file (`vscode.open` still worked) — another reason to restart the
    harness between batches.
11. **code-server serves extension assets through its service worker.** A
    same-version reinstall can keep serving the old CSS. Bump
    `package.json#version` (`2026.9.6` → `2026.11.5`), repack, install with
    `local/install-code-server.sh`, restart the container, reload the tab.

## Regression test

`tests/integration/narrow_table_ix.ts` (11 checks):

- opens `long-table-fail-02.md`, snapshots `media.tables` and `media.zoom`,
  shrinks the workbench page to 500px, and forces a ~300px preview;
- asserts the 6-column table renders, fit mode keeps every table inside the
  reading column and the page clip edge, the last header cell ("Compiler
  toolchain") is visible, and no table needs horizontal scrolling;
- asserts pan mode is a scroll region whose last column is reachable;
- asserts the 200% zoom fallback scrolls internally instead of clipping;
- restores the settings and viewport in `finally`, and `finish()` runs
  `restCleanup()`.

The fixture path comes from `SAMPLES` in `test_utils.ts`, so it resolves the
same way as the other `*_ix.ts` suites.

## Verification

```text
bun tests/integration/narrow_table_ix.ts 9324    → 11/11 checks passed
bun tests/integration/media_controls_ix.ts 9324  →  7/7 checks passed
bun tests/integration/test_preview.ts 9324       → 13/15 (known cursor-sync
                                                     flakes under browser CDP)
npm run test:units                               → all five checks passed
```

State after the run: `media.tables=pan`, `media.zoom=100`,
`media.columnWidth=700px`, `media.invert=auto`, viewport override cleared.

## Lessons learnt

- **Min-content is the whole story for tables.** To make a table shrink, the
  property must reduce the *min-content* contribution of its cells:
  `overflow-wrap: anywhere` does; `break-word`, `hyphens`, and ordinary word
  wrapping do not.
- **A table is not a scroll container by default.** Chromium ignores
  `overflow` on `display: table`; `display: block` is required. Pair it with
  `width: fit-content` or small tables get stretched to full width for free.
- **A scroll region with invisible scrollbars still reads as "lost text".**
  On this platform overlay scrollbars are the default; if the fallback relies
  on scrolling, the affordance (and the docs) must say so.
- **Force layout the way the product does.** Resize the workbench page, not the
  webview's internal iframe styles: the host owns those, and restoring them
  incorrectly leaves the preview at the UA default width (300px).
- **Never select CDP targets by order — including the top-level page.** A
  stray newtab was enough to send `executeCommand`/palette input to the wrong
  tab. Probe for the app shell (`.monaco-workbench`), just as you probe a
  webview for `.toolbar .doc-name`.
- **CDP wheel events are not a reliable oracle for scroll defaults** in this
  nested-iframe/virtual-desktop harness. Scroll the container programmatically
  and assert its geometry; leave real gesture checks to manual/playwright work.
- **Test the negative control.** Removing the single CSS rule and re-measuring
  (259 → 859px) proved the assertion catches the regression instead of passing
  by accident.
- **A reused workbench rots.** After a handful of suites, preview panels pile
  up, `showTextDocument` can hang, and failures look like product regressions.
  Restart the container/browser before believing them (the playbook's §7/§12).
- **A CSS-only change still needs a version bump in code-server** because the
  service worker caches extension resources by URL.

## Follow-ups / known limits

- Below ~400px the toolbar itself overflows: the last three action buttons
  (Pin / Refresh / Open Source) are clipped. The media controls (invert,
  tables, column width, zoom) remain visible, so the table fix is reachable;
  making the toolbar wrap or scroll is a separate UI decision.
- Fit mode at extreme narrow widths (a 6-column table in ~260px) produces very
  narrow columns. That is inherent to "fit"; pan mode is the readable-columns
  alternative.
- A visible scrollbar/fade for pan-mode tables would make the scroll affordance
  discoverable on overlay-scrollbar platforms. Not implemented here.

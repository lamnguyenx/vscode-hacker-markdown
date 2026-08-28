# Bug: `.hmk-stale-holder` traps a stray SPAN for 8s on mermaid refresh — persistent "Re-rendering…" badge + blank space

**Status:** CLOSED (fixed 2026-08-28)
**Affected:** `src/webview/stale.ts` (webview bundle → `build/index.js`)
**Severity:** high (every mermaid refresh showed an 8-second "Re-rendering…" badge with blank whitespace around the wrong element, making the preview feel frozen despite the actual render taking ~40ms)
**Regression test:** [`tests/mermaid_stale_check.cjs`](../../../tests/mermaid_stale_check.cjs)

## Summary

Refreshing a document with a mermaid diagram triggered the stale-diagram keeper
(`snapshotStaleBlocks` → `keepStaleBlocks`) on the wrong element: the rendered
`.mermaid-wrapper` from the old document was captured as an anonymous gap block,
but the new fragment's `<pre class="mermaid">` keeps its `data-line` (built-in
engine source map) and is therefore *not* a gap block. The positional keying
(`gapIndex`/`gapOrder`) then paired the old wrapper with a **sibling `SPAN`**
at the same gap slot, wrapped that SPAN in a `.hmk-stale-holder`, and waited
8 seconds for an SVG to appear inside it — an SVG that, by construction, would
never land there.

Result on every mermaid refresh:

- a `.hmk-stale-holder` with `min-height` set to the old diagram's height sat
  in flow (not as a true overlay, but as a block taking layout space),
- the "Re-rendering…" badge (`::after` pseudo-element) persisted for the full
  8s fallback timer,
- the actual diagram (re-rendered ~40ms in) was visible elsewhere, so the net
  effect was a misleading badge + a block of blank whitespace lasting 8s.

The render pipeline itself was fast — `exp/measure-render.cjs` measured a
40ms median host→webview round-trip; the entire 8s delay was the stale keeper.

## Root cause

`snapshotStaleBlocks` (`src/webview/stale.ts`) walks `previewEl.children` and,
for each child without `data-line`, classifies it as a stale block candidate
if it is/contains an `img`/`svg` taller than 60px:

```js
} else if (child.tagName === 'IMG' || child.tagName.toUpperCase() === 'SVG' || child.querySelector('svg, img')) {
    const height = child.getBoundingClientRect().height;
    if (height > 60) {
        out.push({ gapIndex: lineCount, gapOrder: gapOrder++, el: child, height });
    }
}
```

For mermaid, this is fundamentally broken because of an asymmetry between the
old (rendered) DOM and the new fragment:

| | Old DOM (after mermaid rendered) | New fragment (from `markdown.api.render`) |
|---|---|---|
| Element | `<div class="mermaid-wrapper">…<svg>…</div>` | `<pre class="mermaid" data-line="0">…</pre>` |
| Has `data-line`? | **No** (the mermaid plugin's `replaceWith` drops it) | **Yes** (engine source-map core rule) |
| Gap slot | Landed in anonymous gap (`gapIndex=0, gapOrder=0`) | Counted as a `data-line` element → **not** a gap |

On the next render, `keepStaleBlocks` walks the new DOM's children, finds
`SPAN` (the first anonymous gap block at `gapIndex=0, gapOrder=0` — its
existence depends on the doc, e.g. a trailing whitespace span), pairs it with
the old `.mermaid-wrapper`, and routes it into `holdPlaceholderHeight`:

```js
function holdPlaceholderHeight(oldEl, newEl, height) {
    // …wrap newEl in a min-height holder, observe for svg/img…
    const filled = () => !!holder.querySelector('svg, img');
    // …observer unwraps when filled()…
    setTimeout(() => { observer.disconnect(); finish(); }, 8000); // fallback
}
```

The SPAN never fills with `svg`/`img`, so the observer's `filled()` never
returns true; the holder lives until the hard 8s fallback.

The keeper was designed for two patterns (stale.ts docstring): the **img**
pattern (old `<img>` kept faded until the new URL loads — used by puml) and the
**container** pattern (placeholder held at old height until mermaid/KaTeX fills
it — but this was for the *placeholder*, not the *wrapper*). Mermaid's own
library handles its re-render lifecycle: it calls `replaceWith` on the old
`.mermaid-wrapper` and re-renders into the new node; and the anchor guard
(`src/webview/anchor.ts`) holds the scroll position across the async render.
The stale keeper adds nothing here and — due to the `data-line` asymmetry —
actively misfires.

## Fix (`src/webview/stale.ts`)

Exclude `.mermaid-wrapper` (and its descendants) from the stale snapshot,
mirroring the same exclusion already in `frames.ts:100` (`isFrameable`):

```diff
 } else if (child.tagName === 'IMG' || child.tagName.toUpperCase() === 'SVG' || child.querySelector('svg, img')) {
+    // Mermaid's library handles its own re-render; the positional keying
+    // here mispairs the old wrapper (no data-line) with a sibling at the
+    // same gap slot, trapping it in a holder for 8s. The anchor guard
+    // covers the scroll position for mermaid.
+    if (child.closest('.mermaid-wrapper')) {
+        continue;
+    }
     const height = child.getBoundingClientRect().height;
```

The img keeper (puml) and the container hold for genuine placeholder renderers
are unchanged.

## Verification

### `tests/mermaid_stale_check.cjs` (live CDP regression test)

Connects to the webview OOPIF, triggers a refresh of a mermaid document, polls
the preview DOM at 10ms intervals for 3s, and asserts `.hmk-stale-holder` /
`.hmk-stale` never appears.

| Build | Result | Holder samples |
|---|---|---|
| Fixed | PASS | 0 / 287 |
| Pre-fix (reverted) | FAIL | 286 / 287 |

```sh
vscode_cdp --profile "$PWD/exp/devhost" --file "$PWD/tests/samples/mermaid-fail.md"
node tests/mermaid_stale_check.cjs 9032
```

### `exp/measure-render.cjs` (round-trip timing)

```sh
node exp/measure-render.cjs 9032 5
```

Before/after host→webview render round-trip unchanged (~40ms median) — confirms
the bug was purely the webview-side stale keeper, not the host pipeline.

## Trials and errors

- **Suspect #1 — the mermaid library was slow.** `exp/measure-render.cjs`
  measured a 40ms median host→webview round-trip on 5 runs; the SVG appeared
  ~190ms after `msg:render` (mermaid's async render). Not the bottleneck.
- **Suspect #2 — the PlantUML inliner or a rebuild was triggered.** No custom
  styles configured (`hasUserStyles()` → false), so `refresh()` skipped the
  `rebuild()` path. The host pipeline was clean.
- **The real culprit surfaced when polling the DOM state over time**: an
  observer captured `.hmk-stale-holder` containing a `SPAN` (not a `pre.mermaid`),
  `svg=false` the entire time, for the full 8s window. The positional key was
  the smoking gun: the old wrapper had no `data-line`, the new `pre.mermaid`
  did — so they never occupied the same gap slot.

## Related

- [`docs/issues/bugs/2026/08/18/2026-08-18-stale-holder-traps-inlined-svg-8s-frame-lost.md`](../18/2026-08-18-stale-holder-traps-inlined-svg-8s-frame-lost.md)
  — the sibling bug for inlined PlantUML SVGs (same 8s symptom, different
  cause: `holdPlaceholderHeight` waiting on already-rendered content).
- [`docs/plans/2026/08/28/2026-08-28-distinct-invert-per-svg-source.md`](../../../plans/2026/08/28/2026-08-28-distinct-invert-per-svg-source.md)
  — same-day change that touches the same mermaid/PlantUML distinction in CSS.

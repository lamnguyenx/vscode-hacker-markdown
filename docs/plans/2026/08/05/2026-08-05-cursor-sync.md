# Plan: Cursor sync (editor cursor -> preview highlight)

**Date:** 2026-08-05
**Status:** DONE (verified: `npm run compile` + `node tests/plantuml_check.cjs` + dev-host `test_preview.cjs`)
**Files added:** `src/webview/cursor.ts`
**Files edited:** `package.json`, `src/webview/{types,main}.ts`, `src/previewHost.ts`,
`src/previewManager.ts`, `src/plantuml/fences.ts`, `src/media/main.css`,
`tests/{plantuml_check,test_preview}.cjs`,
`docs/important/{architecture,how-to-test}.md`

## Goal

When the editing cursor moves in the Markdown editor, highlight the
corresponding block in the preview with a **blue outline box** (`.hmk-cursor`).
Two cases:

1. cursor on a source line -> highlight the matching rendered line
   (paragraph, heading, list item, code fence, …);
2. cursor inside a rendered block (a `plantuml`/`puml`/`uml` fence rendered to a
   PlantUML-server `<img>`) -> highlight the rendered media instead.

One-way (editor -> preview), independent of scroll sync, gated behind a new
setting `hackerMarkdown.cursorPreviewWithEditor` (default `true`, mirroring
`hackerMarkdown.scrollPreviewWithEditor`). Visual style decided with the user:
a rounded blue outline box; a new setting defaulting to ON.

## Why this approach

The preview fragment already carries the source-map the built-in preview uses:
`markdown.api.render` tags every block token with `data-line` =
`token.map[0]` (the block's start line, 0-based) — see
`_refs/vscode/extensions/markdown-language-features/src/markdownEngine.ts` and
the built-in `preview-src/scroll-sync.ts`. The built-in preview uses these to
find "the element for a source line" and even computes a fenced code block's
`endLine = data-line + newline count` (scroll-sync.ts:59-66).

Our PlantUML rewrite (`src/plantuml/fences.ts`) currently replaces the fence's
`<pre data-line>` with `<img>`s, **dropping all source-map attributes**, so a
cursor inside a puml fence has nothing to map to. The fix: carry the fence's
source span onto the generated `<img>` as `data-hmk-from`/`data-hmk-to`
(kept off the engine's `data-line` name so there is no ambiguity), computed the
same way the built-in computes `endLine`.

Resolution order in the webview (fallback chain the user asked for):

1. **rendered media**: an element whose `data-hmk-from <= line <= data-hmk-to`
   -> highlight that `<img>` (the box sits on the img inside `.hmk-frame-content`,
   so it scales with the pan/zoom transform);
2. **exact line**: an element with `data-line === line` -> highlight it;
3. **containing block**: the element with the greatest `data-line <= line`
   (prefer the innermost/nested, i.e. the last in document order) -> highlight
   it. This is the paragraph/code-fence fallback for cursor lines that have no
   block of their own (mid-paragraph, inside a plan-language code fence, on a
   blank line).
4. nothing in range -> no highlight.

## Design

### Host -> webview message (`src/webview/types.ts`)

Add to `HostMessage`: `| { type: 'cursorLine'; line: number }`.

`src/previewHost.ts` gains a `cursorLine(line)` method (sibling of
`scrollToLine`) that posts the message.

### Pushing cursor position (`src/previewManager.ts`)

- `onEditorSelection` (currently returns early when
  `scrollPreviewWithEditor` is off and is guarded by the scroll-sync grace
  timer) is restructured so cursor posting is **not** gated by either: when
  `cursorPreviewWithEditor !== false`, post `host.cursorLine(active.line)` to
  every host. Scroll-sync code stays untouched (no loop risk — this is
  one-way; preview->editor reveal changing the selection is consistent with
  the highlight anyway).
- `onDidChangeActiveTextEditor` posts the fresh editor's
  `selection.active.line` after `setDocument`, so the highlight appears
  immediately on doc switch (a selection-change event alone may not fire if
  the selection did not move).

The webview stores the line (`lastCursorLine`) and re-applies it after every
render, so messages that arrive before/independently of a render still end up
correct.

### PlantUML range attributes (`src/plantuml/fences.ts`)

- `PUML_FENCE_REG` is changed to capture the `<pre>` attribute string; parse
  `data-line="N"` from it (tolerate its absence).
- Compute the fence's source span: `to = from + bodyLineCount + 1`, where
  `bodyLineCount` is the line count of the unescaped fence source (trailing
  blank line trimmed). This covers every content line plus the closing fence
  line (`from` = opening fence line).
- Emit each generated `<img>` with `data-hmk-from="N" data-hmk-to="M"`; with
  no `data-line` on the pre, emit no range (graceful degrade — the cursor then
  falls back to the containing block).

### Webview resolver + apply (`src/webview/cursor.ts`, new)

Pure-enough module (same style as `anchor.ts`/`stale.ts`) with the 3-step
resolution above against `previewEl` (reuses `dataLineElements()` from
`line-sync.ts`), plus:

- `applyCursorHighlight(line)`: strip any existing `.hmk-cursor`, resolve,
  add the class to the target (the `<img>` for rendered media, the block
  element otherwise).
- `clearCursorHighlight()` / `setCursorLine(line)` / `lastCursorLine` module
  state.

### Wiring (`src/webview/main.ts`)

- Handle the `'cursorLine'` message -> `setCursorLine(line)`.
- In `render()`, after the DOM swap + `scanFrames()`, re-apply
  `lastCursorLine` (re-renders recreate every element, wiping the class).
- Re-apply on late renders: `scheduleFrameScan`'s timer already re-runs after
  contributed scripts replace placeholders; call `applyCursorHighlight(lastCursorLine)`
  in that path too, so highlighted media that got swapped is re-caught.

### Style (`src/media/main.css`)

```css
.hmk-cursor {
  outline: 2px solid var(--vscode-focusBorder, #0078d4);
  outline-offset: 1px;
  border-radius: 6px;
}
```

## Changes

- `package.json` — `configuration` += `hackerMarkdown.cursorPreviewWithEditor`
  (boolean, default `true`).
- `src/webview/types.ts` — `HostMessage` += `cursorLine`.
- `src/previewHost.ts` — `cursorLine(line)` method.
- `src/previewManager.ts` — post `cursorLine` in `onEditorSelection` (not
  gated by the scroll setting/grace) + on `onDidChangeActiveTextEditor`.
- `src/plantuml/fences.ts` — capture `data-line`, emit `data-hmk-from/to`.
- `src/webview/cursor.ts` — new resolver + highlight module.
- `src/webview/main.ts` — message handler + re-apply on render & late renders.
- `src/media/main.css` — `.hmk-cursor`.
- `tests/plantuml_check.cjs` — assert `data-hmk-from`/`data-hmk-to` are present
  and correct (single fence, multi-`newpage`, no-range when the pre lacks
  `data-line`).
- `tests/test_preview.cjs` — new cursor-sync check: focus the editor, `Ctrl+G`
  to a known line, assert `.hmk-cursor` appears in the webview with the
  expected `data-line` (and the containing-block fallback on a mid-paragraph /
  in-code-fence line). Self-contained (no PlantUML server needed).
- Docs — `architecture.md` feature bullet + limitation; `how-to-test.md` check
  list + quick reference.

## Verification

1. `npm run compile` (strict TS, esbuild bundle) and
   `node tests/plantuml_check.cjs` — **pass** (data-hmk spans, newpage, no-data-line degrade).
2. Dev-host smoke test: `tools/launch-devhost.sh`, `node tests/open_view.cjs 9335`,
   `node tests/test_preview.cjs 9335` — **21/21**, including the three new
   cursor-sync checks (exact h3, blank-line → h1 fallback, in-code-fence → the
   `<pre>`).
3. Manual: cursor inside a puml fence on the puml host (3e/3d) highlights the
   rendered `<img>`/frame; cursor inside the mermaid block degrades to the
   containing paragraph (see limitations).

## Known limitations

- Rendered blocks we do **not** rewrite (mermaid via contributed
  `markdown.previewScripts`, `jebbs.plantuml`'s in-engine `<img>`) carry no
  `data-hmk-*` range, so a cursor *inside* such a fence falls back to the
  containing block above it. Puml rendered by our rewrite always gets the
  range.
- The highlight maps against the currently-rendered (possibly stale under
  `renderOnSave`) document — same staleness caveat as scroll sync.
- It is a highlight only; moving the cursor does not scroll unless
  `hackerMarkdown.scrollPreviewWithEditor` is also on.

## Trials, errors & deviations (chronological)

1. **`data-line` semantics confirmed.** `markdownEngine.ts` sets
   `data-line = token.map[0]` (block start line) on every block token; the
   built-in scroll-sync computes a fenced block's `endLine` by counting
   newlines in the `<code>`. We mirror that math exactly for the puml span.
2. **Do not reuse the `data-line` name for the span.** `data-line` already has
   a precise meaning (block start); using a second `data-line` on the same img
   would break `dataLineElements()`/stale/frames scanning. New names
   `data-hmk-from`/`data-hmk-to`.
3. **Resolution order matters.** The rendered-media check must run *before* the
   containing-block fallback: inside a puml fence there is no `data-line`
   element at all, so the "greatest data-line above" would be the sibling
   above the diagram. With the range first, the cursor maps to the media.
4. **Highlight is class-only.** `.hmk-cursor` adds no DOM structure, so it
   cannot disturb the pan/zoom frames, stale keepers, or the anchor guard; and
   `unwrapFrames()` keeps the img's attributes, so the range survives
   re-renders and the highlight is re-applied from `lastCursorLine`.
5. **A fenced block's `data-line` sits on the inner `<code>`, not the
   `<pre>`.** Dumping the rendered fragment: `<pre><code data-line="10"
   class="code-line language-python">`. The resolver targets the `<code>`
   (exact/fallback both resolve to it) and must **hoist the box to the
   `<pre>`** (`blockTarget`) — exactly what the built-in preview does in
   `scroll-sync.ts` when it wraps a `CODE` entry as its `PRE` parent. The
   first smoke run's "inside a code fence" check failed because the assertion
   expected the class on `PRE` while it landed on `CODE`.
6. **The "editor panel follows the same document" smoke check fails in this
   environment independently of this feature** (verified against pristine
   `git stash`ed code: 17/18). It is the documented panel race — opening the
   editor-area WebviewPanel makes it the active tab and `activeTextEditor`
   `undefined`, which empties every host. Applied the docs' own stated
   workaround to the test: click back to the `sub.md` tab before asserting the
   panel's doc-name. With the fix the suite is 21/21.
7. **"Nothing is blue" in the user's installed window was a theme bug, not a
   feature bug.** The dev-host smoke test passed (dark+ theme, default
   `--vscode-focusBorder`), but in the user's real window (installed via
   `make install`, theme "Eink 60Hz") nothing showed. Root cause: Eink 60Hz
   sets `"focusBorder": "#00000000"` (transparent) on a `#000000` preview, and
   `.hmk-cursor` used `var(--vscode-focusBorder, #0078d4)` — a CSS custom-property
   fallback is ignored when the *property resolves to a transparent value*, so
   the outline was painted fully transparent while the class itself was applied
   (scroll sync — a different mechanism — still worked). Fixed by hardcoding
   the blue (`#3b82f6` + a faint halo), verified by forcing
   `--vscode-focusBorder: #00000000` in the live dev host and reading the
   computed `outline-color`.
8. **The media span's `data-line` also lives on the inner `<code>`, and the
   original unit test masked it.** First real-window report after the theme
   fix: cursor at `enroll-flow-elements.puml.md:180` highlighted the `####`
   heading at 163, not the diagram. Root cause: `fenceSourceRange` read
   `data-line` only from the `<pre>` attributes, but the engine puts it on the
   `<code>` (`<pre><code data-line="N" class="code-line language-puml">`), so
   every generated `<img>` got **no** span and the cursor inside the fence fell
   back to the heading above. The pure-logic test passed because its synthetic
   `fenceHtml` placed `data-line` on the `<pre>` — reproducing a shape the real
   engine never emits. Fixed by capturing the whole `<code>` opening tag in the
   regex and reading `data-line` from code attrs (pre attrs kept as a fallback),
   and rewrote `fenceHtml` to match the real engine output. Verified end-to-end
   in a dev host (with `hackerMarkdown.plantuml.server` set + the local server
   on 9274): cursor at line 180 now highlights the rendered puml `<img>`
   (span 164–188, inside `.hmk-frame`).
9. **Follow-up: editor→preview scroll sync now centers the highlighted block.**
   `scrollToLine` (which scrolled *minimum to reveal*) was replaced by a
   centering scroll (`line-sync.ts#centerElement`): the target's center lands
   at the inner window's vertical midpoint, clamped to `[0, scrollHeight -
   innerHeight]` when the content can't reach the center (top/bottom/short
   doc). The re-render restore in `main.ts#render` uses the old minimal-reveal
   (`revealLine`) so re-renders still hand the exact reading position to the
   anchor guard. The scrolled element is the **same** element the cursor box
   draws (`cursorBoxForLine`), so the highlight and the centering always agree
   (media span → the puml `<img>`, code fence → the `<pre>`, else exact /
   containing block). One environment surprise: the toolbar's `position:
   sticky` is not a reliable viewport boundary inside the webview frame, so
   `centerElement` centers on `innerHeight / 2`, not `toolbarBottom()`; the
   resulting ~toolbar-height offset is negligible. Verified in a dev host:
   with the cursor on `enroll-flow-elements.puml.md:180` and 230 the puml
   `<img>` sits at exactly `innerHeight / 2`; near the top it clamps to
   scroll 0 ("as close to center as the content allows").
10. **Follow-up: framed diagram media now fit the preview column (side-clip
    fix).** In the user's real window the preview is docked in a **narrow
    sidebar**, and their `markdown-preview.css` (loaded via `markdown.styles`
    + `hackerMarkdown.styles`) forces `div.hmk-frame` and `img` to `width:
    100vw`. `100vw` is the webview's inner viewport width, which in a narrow
    sidebar can exceed the *visible* webview box, so every diagram was drawn
    wider than the visible area and its side edges were clipped. Static
    analysis of every CSS combination (wide + narrow, with/without the user
    css) showed img-width == frame-width, so the clip could not come from the
    frame — it is the vw-vs-visible overflow. Fix in `main.css`: the zoom
    box gets `max-width: 100%` (of the preview column), and
    `.hmk-frame-content > img/svg` gets `max-width: 100% !important; width:
    auto !important; height: auto !important` so diagram media can never be
    forced wider than their box — diagrams now render at natural size (no more
    3x upscale) or gently downscale to fit, never clipped, aspect preserved.
    Verified in a dev host with the user's css loaded: at a 286px webview, 0
    offscreen frames / 0 img-wider-than-frame / 0 distorted across all 12
    puml diagrams.

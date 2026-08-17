# Plan: Click-to-source (preview click -> editor cursor jump)

**Date:** 2026-08-17
**Status:** DONE (verified: `npm run compile` + `node tests/{plantuml_check,plantuml_completion_check,mermaid_check}.cjs` + dev-host `test_preview.cjs` 23/23)
**Files added:** `src/webview/source.ts`, `src/mermaid/fences.ts`,
`src/mermaid/renderFragment.ts`, `tests/mermaid_check.cjs`
**Files edited:** `package.json`, `src/webview/{types,main,frames,cursor}.ts`,
`src/previewManager.ts`,
`docs/important/{editor-preview-sync,architecture,how-to-test}.md`

## Goal

Click a rendered block in the preview -> the editor scrolls to the
corresponding source line and moves the cursor there, keeping focus in the
preview so you can keep clicking around. This is the reverse of the existing
editor->preview cursor/scroll sync (see
`docs/important/editor-preview-sync.md`).

One-way (preview -> editor), gated behind a new setting
`hackerMarkdown.clickToSource` (default `true`, mirroring
`cursorPreviewWithEditor`). A plain left-click on any rendered content block
(heading, paragraph, list item, code fence, table, rendered puml diagram)
jumps to its source line; modifier-clicks are excluded (Alt drives the frame
pan/zoom gestures, and a pan-drag release must not jump).

## Why this approach

The preview fragment already carries the reverse source map:
`markdown.api.render` tags every block token with `data-line` (the block's
start line) and our PlantUML rewrite adds `data-hmk-from`/`data-hmk-to`
(fence source span) on the generated `<img>`s. `src/webview/cursor.ts` already
resolves *line -> element* in three steps; the reverse (element -> line) is
the same data read the other way, so the new resolver mirrors that chain.

The editor jump itself uses `showTextDocument(doc, { preserveFocus: true,
selection: range })`, which sets the selection atomically on an already-open
(or newly opened) editor without stealing keyboard focus. The selection
change fires `onDidChangeTextEditorSelection`, which re-highlights the same
block in the preview (harmless echo) and would recenter the preview — that
echo scroll is suppressed with the existing scroll-sync grace timer
(`lastPreviewScrollAt`), so the block you clicked stays put.

## Design

### Webview -> host message (`src/webview/types.ts`)

Add to `WebviewMessage`:
`| { type: 'editorLine'; line: number }`.

### Element -> line resolver (`src/webview/source.ts`, new)

Pure DOM module (same style as `cursor.ts`/`anchor.ts`), reusing
`dataLineElements()` from `line-sync.ts`. Resolution order (first match
wins):

1. **Media** — the click target is inside `[data-hmk-from]` or inside a
   `.hmk-frame` wrapping one -> jump to `data-hmk-from` (the fence's opening
   line).
2. **Block** — the target or an ancestor has `data-line` -> that line
   (`closest` handles the code-fence case where the engine puts `data-line`
   on the inner `<code>`).
3. **Geometric fallback** — no mapped element (blank line, `<pre>` padding):
   the last `data-line` element whose `rect.top <= clickY` (the block above),
   matching the cursor-sync containing-block semantics.
4. None -> `undefined` (no jump; e.g. clicks above the first block).

Exported as `sourceLineForClick(target, clickY)`.

### Click wiring (`src/webview/main.ts`)

In the existing `previewEl` click handler, after the `[data-command]` and
`a[href]` checks: if no modifier key is held and `sourceLineForClick`
resolves a line, `post({ type: 'editorLine', line })`.

### Drag-release guard (`src/webview/frames.ts`)

A pan/zoom drag-release fires a `click` event on the frame. Today the frame's
click listener only `stopPropagation()`s the Alt+click zoom path; a plain
drag release bubbles up. Change: when the frame runtime's `dragged` flag is
set, `e.stopPropagation()` before returning so a drag never triggers a
source jump. (Frame toolbar buttons already `stopPropagation`.)

### Host handler (`src/previewManager.ts`)

In `onHostMessage` add `case 'editorLine'`. New method `revealEditorLine`:

- early-return if no `this.doc` or if `hackerMarkdown.clickToSource` is off;
- `this.lastPreviewScrollAt = Date.now()` (swallow the echo recenter);
- clamp the line to `[0, doc.lineCount - 1]`;
- `vscode.window.showTextDocument(doc, { preserveFocus: true, selection:
  new vscode.Range(line, 0, line, 0) })`.

### Setting (`package.json`)

`hackerMarkdown.clickToSource` (boolean, default `true`).

### Docs

- `docs/important/editor-preview-sync.md` — update "Direction" (both ways
  now), add a "Click-to-source (preview -> editor)" section, update the
  settings table and the limitations bullet that claimed "no reverse
  direction".
- `docs/important/architecture.md` — extend the cursor-sync bullet + settings
  and adjust the limitation bullet.
- `docs/important/how-to-test.md` — document the new smoke check in the
  cursor-sync section.

## Verification

1. `npm run compile` (strict TS + esbuild bundle) — **pass**.
2. Dev-host smoke test: `tools/launch-devhost.sh`, `node tests/open_view.cjs 9335`,
   `node tests/test_preview.cjs 9335` — existing 21/21 plus the new
   click-to-source check (see below).
3. Manual (puml fixture + server): click a rendered diagram -> editor cursor
   lands on the fence's opening line, the `.hmk-cursor` box stays on the
   diagram; click a heading/paragraph -> editor jumps; Alt+drag a diagram ->
   no jump; click a link -> link opens, no jump; clicking the empty area
   below the last block -> no jump.

### New smoke checks (extend §6e in `test_preview.cjs`)

Uses only existing primitives (the OOPIF `first.session` + the workbench
`pageCursor` session from the cursor-sync block):

1. Ctrl+G the editor to line 13 (0-based 12) so the preview highlights the
   python fence (`<pre>`).
2. CDP-click the `h3[data-line="6"]` in the preview (scroll it into view,
   get its rect, dispatch trusted mouse events on `first.session`).
3. `evalUntil`: `.hmk-cursor` is the `h3` with `data-line="6"`.
4. CDP-click the rendered `.mermaid-wrapper`; `evalUntil` `.hmk-cursor`
   lands on the wrapper whose `.mermaid` child carries `data-hmk-from="57"`.

The highlight moving proves the full chain: click -> `editorLine` message ->
host moved the editor selection -> `onDidChangeTextEditorSelection` echoed
the line -> preview re-highlighted. (No monaco introspection needed.)

## Known limitations

- Only *rendered* content maps to source; the map follows the
  currently-rendered (possibly stale under `renderOnSave`) document — same
  caveat as cursor/scroll sync.
- A click on blank space falls back to the block *above* the click (geometric
  fallback), so a very short doc where the last block ends mid-viewport maps
  empty space below it to that last block. Clicks above the first block do
  nothing.
- The editor cursor is placed at the block's start line (`data-line`); for a
  code fence that is the opening fence line (matches cursor-sync). No whole-
  line selection is made.
- Mermaid spans are zipped by document order against the fragment's mermaid
  blocks; a mermaid block that appears in the fragment without a matching
  document span (an exotic renderer path) gets no range and falls back to the
  containing block.

## Trials, errors & deviations (chronological)

1. **The frame drag-release click needed a guard.** The frame's click
   listener returns early without `stopPropagation` when `altKey` is held but
   the gesture was a drag (`s.dragged`), so a pan-drag release would have
   bubbled to the preview click handler and jumped. Fix: `stopPropagation`
   when `s.dragged`, which covers both Alt+drag and pan-mode drags.
2. **Frame wrapper padding clicks.** Clicking a `.hmk-frame` div's padding
   has no `[data-hmk-from]` ancestor (the img is a child, not an ancestor), so
   the media step also checks `target.closest('.hmk-frame')` and reads the
   frame's `[data-hmk-from]` child. Since drag-releases no longer bubble, any
   click reaching the handler inside a frame is a deliberate click.
3. **Geometric fallback uses `rect.top <= clickY`, not containment.** The
   click lands between blocks; containment would fail. "Last block whose top
   is above the click" gives the block the cursor should go to (the one the
   reader is looking at).
4. **The anchor early-return swallowed click-to-source.** The first
   implementation put the source-jump *after* the link handler's
   `if (!anchor) return;` — so no non-anchor click ever reached it (the smoke
   check failed with "no highlight move"). Fixed by restructuring the handler
   to `if (anchor) { handle link; return; }` and only then falling through to
   click-to-source.
5. **Mermaid drops the engine's `data-line`.** The mermaid markdown-it plugin
   (`extendMarkdownItWithMermaid`) renders ```mermaid fences to
   `<pre class="mermaid">` via a custom renderer rule that returns a raw
   string, ignoring token attrs — so the built-in `source_map_data_attribute`
   core rule's `data-line` never makes it into the fragment. Clicking a
   rendered diagram fell back to the heading above it. Fix (mirrors the puml
   rewrite): a new pure module `src/mermaid/fences.ts` scans the **document**
   for mermaid fences/containers (```` ```mermaid ````, `~~~mermaid`,
   `:::mermaid`) and zips the spans onto the fragment's `.mermaid` blocks in
   order; `previewManager.render()` runs it right after the puml rewrite.
   This also fixes cursor *highlight* inside mermaid fences (the `.mermaid`
   element now carries `data-hmk-from/to`).
6. **The mermaid `.mermaid` pre is `display: unset` (inline), so its own
   bounding box is a sliver** — clicking "the diagram" by the pre's rect hit
   the resize handle instead. Users click the visible `.mermaid-wrapper`, which
   the media step resolves via the wrapper fallback. The cursor *box* is hoisted
   to the wrapper too (`cursor.ts#blockTarget`), so the highlight outlines the
   whole diagram.
7. **Mermaid pan-drags bubble a click.** Mermaid's own `handleClick` returns
   without `stopPropagation` for non-alt/dragged clicks, so a pan-mode drag
   release would jump. Covered by a generic drag guard in `main.ts`: a
   document-level `mousedown` records the position and the click-to-source
   handler skips clicks that moved >4px since mousedown (frames are already
   guarded individually).
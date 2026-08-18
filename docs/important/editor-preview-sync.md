# Editor ↔ Preview Sync (cursor highlight + scroll)

How the preview tracks the Markdown editor: the cursor-highlight box
(`.hmk-cursor`), the recentering scroll-on-cursor-move, and the reverse
scroll-to-editor. This is the deep dive behind the "Cursor sync (highlight)"
and "Scroll sync" bullets in
[`architecture.md`](architecture.md); the plan that built the cursor half is
[`docs/plans/2026/08/05/2026-08-05-cursor-sync.md`](../../plans/2026/08/05/2026-08-05-cursor-sync.md).

## Direction & the four settings

Sync flows **both ways** between the editor and the preview, but each feature
is one-way: nothing "loops" — an editor selection change never re-enters the
editor, and a preview scroll never re-scrolls the preview.

| Setting | Default | What it drives |
| --- | --- | --- |
| `hackerMarkdown.cursorPreviewWithEditor` | `true` | Blue outline box around the rendered block matching the cursor line. Independent of scroll sync. |
| `hackerMarkdown.scrollPreviewWithEditor` | `true` | Preview recenters so the highlighted block lands at the vertical center of the viewport. |
| `hackerMarkdown.scrollEditorWithPreview` | `true` | Scrolling the preview reveals the matching line in the editor. |
| `hackerMarkdown.clickToSource` | `true` | Clicking a rendered block in the preview moves the editor cursor to the matching source line. |

## Message flow (host → webview)

The host owns the source of truth (the editor's selection) and broadcasts to
**every** attached host (docked views + editor panels) — see
`src/previewManager.ts`:

1. `onEditorSelection` (`previewManager.ts:436`) fires on every selection
   change in the tracked document. It posts `cursorLine` **unconditionally**
   when `cursorPreviewWithEditor` is on — cursor highlight is *not* gated by
   the scroll setting or the scroll-sync grace timer (`previewManager.ts:441-445`).
   It then decides whether to also scroll (see below).
2. `onDidChangeActiveTextEditor` (`previewManager.ts:35`) pushes
   `selection.active.line` right after `setDocument` (`previewManager.ts:46-50`),
   because a doc switch does not always fire a selection-change — without this,
   the highlight would only appear on the first render.
3. `PreviewHost.cursorLine(line)` / `scrollToLine(line)` (`previewHost.ts:131-137`)
   post `{ type: 'cursorLine' | 'scrollToLine', line }` (contract in
   `src/webview/types.ts:22-23`).
4. The webview applies them immediately — no render round-trip needed
   (`src/webview/main.ts:91-101`).

## Click-to-source (preview → editor)

Clicking a rendered block in the preview moves the editor cursor to the
matching source line and scrolls it into view, keeping keyboard focus in the
preview so you can keep clicking around. Gated behind
`hackerMarkdown.clickToSource` (default on).

The webview resolves the click to a line in `src/webview/source.ts`
(`sourceLineForClick`), the reverse of the `cursor.ts` chain:

0. **SALT mockup inside an inlined PlantUML SVG** — the click is inside a
   mockup: `[data-source-code]` (a note mockup's exact source span, translated
   via the enclosing fence) or `svg [data-hmk-from][data-hmk-to]` (a
   procedure-rendered activity mockup's first-occurrence invocation line,
   attached by `attachMockupRanges`) → the whole range, so the host selects
   the exact lines that produced the mockup (`editorLine` carries `from`/`to`;
   `revealEditorRange`). Both are resolved through `mockupRange`
   (`src/webview/source-code.ts`).
1. **Rendered media** — the click is inside `[data-hmk-from]` or inside a
   `.hmk-frame` / `.mermaid-wrapper` wrapping one → the media's source span.
   Puml fences get the span from the fragment's `data-line`
   (`src/plantuml/fences.ts`); **mermaid** gets it from the document — the
   mermaid plugin's custom renderer drops the engine's `data-line`, so
   `src/mermaid/fences.ts` scans the markdown source for ```mermaid / ~~~mermaid
   / :::mermaid blocks and zips the spans onto the fragment's `.mermaid`
   elements (`previewManager.render()` runs this right after the puml rewrite).
2. **Block** — the target or an ancestor has `data-line` → that line (works
   for fenced blocks, whose `data-line` sits on the inner `<code>`).
3. **Geometric fallback** — no mapped element (blank line, `<pre>` padding):
   the last `data-line` element whose top is above the click → the block
   above, matching the cursor-sync containing-block semantics.
4. Nothing → no jump (clicks above the first block / empty preview).

It is wired into the `previewEl` click handler in `main.ts` *after* the
`[data-command]` and `a[href]` checks (so links and toolbar buttons are
unaffected), and only for plain clicks — modifier-clicks are excluded (Alt is
the frame/mermaid pan/zoom gesture modifier) and a click whose mouse moved
since mousedown is treated as a drag-release (pan/zoom), not a click, so a
dragged diagram never jumps.

The webview posts `{ type: 'editorLine', line }` — with `from`/`to` for a salt
mockup; the host handler `revealEditorLine` / `revealEditorRange`
(`previewManager.ts`) checks the setting, stamps `lastPreviewScrollAt` (so the
scroll-sync grace timer swallows the echo recenter), clamps to the document,
and calls `showTextDocument(doc, { preserveFocus: true, selection: range })` —
the selection change re-highlights the same block in the preview (harmless
echo), but the preview does not move. The editor's cursor-line highlight is
the visual "you are here".

## Cursor highlight: the resolution chain

`src/webview/cursor.ts` resolves a source line to a rendered element in four
steps, first match wins:

0. **SALT mockup inside an inlined PlantUML SVG** — an element whose source
   range contains the line, resolved by `mockupRange`
   (`src/webview/source-code.ts`): note mockups via `data-source-code` (the
   1-based, diagram-relative range the server embeds, translated via the
   enclosing fence's `data-hmk-from`); activity mockups via the
   `data-hmk-from`/`data-hmk-to` the webview attached from the host's
   `data-hmk-salts` (first-occurrence invocation lines). Must run before the
   media step: the `<svg>`'s whole-fence span would otherwise always shadow
   the exact mockup. The box lands on the mockup itself — the `<g>` for
   notes, the `<image>` for activity mockups (outline + drop-shadow glow;
   both sit inside the pan/zoom transform, so they scale with the diagram).
1. **Rendered media** — an element whose `data-hmk-from`..`data-hmk-to`
   source span contains the line. These are emitted only by our puml fence
   rewrite (`src/plantuml/fences.ts:58-68`): it reads the fence's `data-line`
   (which the built-in engine puts on the inner `<code>`, falling back to the
   `<pre>`) and applies the same end-line math the stock preview uses
   (`to = from + bodyLineCount + 1`). The box lands on the `<img>`/`<svg>`
   inside `.hmk-frame-content`, so it scales with the pan/zoom transform.
2. **Exact line** — an element with `data-line === line`.
3. **Containing block** — the element with the greatest `data-line <= line`,
   innermost/last in document order (a paragraph, a code fence, a heading for
   a blank line).

The target is hoisted before the box is drawn (`blockTarget`, `cursor.ts`):
a fenced block's `data-line` sits on the inner `<code>`, so the outline wraps
the whole `<pre>`; rendered media inside a pan/zoom frame is boxed at the
*frame*, not the inner img/svg; a salt mockup (`<g>` or `<image>`) is boxed
at itself.

`cursorBoxForLine(line)` (`cursor.ts:37`) resolves the *same* element scroll
sync centers on, so the highlight box and the recentering always agree.

### Re-application

Renders recreate every element (wiping the class), so:

- `render()` in `main.ts` re-applies `lastCursorLine` after the DOM swap
  (`main.ts:63`), and
- the frame-scan `MutationObserver` (`main.ts:139-142`) re-applies it on late
  async renders (contributed scripts like mermaid replace their placeholders
  after the swap), so highlighted media that got swapped is re-caught.

### Staleness caveat

The highlight maps against the *rendered* document. Under the default
`renderOnSave`, typing moves the cursor into source that has not rendered yet,
so the box tracks the last-rendered state — same caveat as scroll sync.

## Scroll sync

### Editor → preview (recenter)

When `scrollPreviewWithEditor` is on, `onEditorSelection` scrolls every host
to the cursor line — but only if no preview-initiated scroll happened in the
last `SCROLL_SYNC_GRACE_MS` (1500ms, `previewManager.ts:449`). This grace
timer is the loop guard: the reverse direction sets
`lastPreviewScrollAt`, and the forward direction is suppressed while it is
warm.

The webview recenters via `centerElement` (`src/webview/line-sync.ts:80`):
the target's vertical center lands at `innerHeight / 2`, clamped to
`[0, scrollHeight - innerHeight]` when the content cannot reach the center
(top/bottom of a short document = "as centered as the content allows"). The
recenter targets `cursorBoxForLine(line) ?? elementForLine(line)`, i.e. the
same element the cursor box draws. Note it centers on `innerHeight / 2`, *not*
`toolbarBottom()` — `position: sticky` on the toolbar is not a reliable
viewport boundary inside the webview frame.

The scroll is flagged `markProgrammaticScroll()`
(`src/webview/programmatic-scroll.ts`) so the resulting `scroll` event is not
mistaken for a user scroll (which would cancel the anchor guard).

### Preview → editor (reveal)

Scrolling the preview posts `{ type: 'scrollLine', line }` (throttled 120ms,
`reportScrollLine` in `line-sync.ts:114`). `onPreviewScroll`
(`previewManager.ts:462`) reveals the line in the editor with
`revealRange(…, AtTop)` — again guarded by the grace timer
(`lastEditorSyncAt`), so the reverse scroll does not loop back into a preview
scroll.

### Render-time restore is *not* the same thing

The render-time reading-position restore in `render()` (`main.ts`) uses
`revealLine` (minimal reveal, `line-sync.ts:105`) handed to the anchor guard
(`src/webview/anchor.ts`), so re-renders never recenter away from the
reader's place. Only *cursor-driven* scrolls recenter.

## Interaction with pin

While the preview is pinned, sync keeps working **only when the editor shows
the pinned document** — the sync handlers are keyed on document identity, so
cross-document sync stops automatically while pinned. See the pin section in
`architecture.md`.

## Sync across windows & placement

The preview can live in the Panel, either Sidebar, the editor area, or in a
**different window** (drag the editor tab / `View: Move Editor into New
Window`). Sync is **per window**: each window runs its own extension host, so
the moved panel is re-created there by the `WebviewPanelSerializer`
(`onWebviewPanel:hackerMarkdown.panel`; the webview persisted the shown
document with `acquireVsCodeApi().setState`, the serializer re-opens it) and
follows *that* window's active editor like any other host — cursor highlight,
click-to-source and scroll sync all keep working in the new window. The
`hackerMarkdown.open` command and the `hackerMarkdown.togglePreview` shortcut
reveal the docked view once it has been resolved, and otherwise fall back to
(reusing) the editor panel, so a preview always appears.

## Limitations

- **Rendered blocks we don't rewrite carry no span.** Renderers beyond our
  puml/mermaid rewrites (e.g. `jebbs.plantuml`'s in-engine `<img>`, KaTeX
  output) have no `data-hmk-*`, so a cursor *inside* such a block falls back
  to the containing block above it, and a click on it jumps to that containing
  block. Puml and mermaid rendered by our rewrites always get the range.
- **Salt granularity depends on the server + a positional zip.** Within an
  inlined puml SVG, note-on-link mockups carry the server's exact
  `data-source-code` range; procedure-rendered activity mockups (`SALT(x)`)
  get the first-occurrence invocation line — the server renders one mockup per
  distinct alias, so `src/plantuml/invocations.ts` scans the document, the
  host embeds the lines (`data-hmk-salts`), and the webview
  (`attachMockupRanges`) zips them onto the rangeless `<image>`s in SVG order.
  The zip is positional: a diagram whose mockup order diverges from
  first-invocation order maps wrong; excess mockups keep the whole-fence
  fallback.
- **Highlight is cursor-only.** Moving the cursor does not scroll unless
  `scrollPreviewWithEditor` is also on.
- **Click-to-source maps the rendered (possibly stale) document.** Under
  `renderOnSave`, clicking a block jumps to its line in the last-rendered
  state — same caveat as the other directions. A click on blank space falls
  back to the block above; clicks above the first block do nothing.
- **One-way preview → editor scroll is reveal-only** (`AtTop`), not centered —
  only the editor → preview direction recenters. Click-to-source is a separate
  mechanism (a click, not a scroll).

## Testing

- The smoke suite's cursor-sync checks (3) are documented in
  `how-to-test.md` (§7e): they drive the editor with `Ctrl+G` (Go to Line),
  which takes a **1-based** line number while the fragment's `data-line`
  attributes are **0-based**.
- Highlighting a live rendered puml diagram is *not* in the default smoke
  suite: the `data-hmk-from`/`data-hmk-to` span emission, the `!pragma
  sourceFile` injection and the SALT invocation scan are pinned by
  `tests/plantuml_check.cjs`, and the SVG inlining by
  `tests/plantuml_inline_check.cjs` (pure logic, no server). Verifying the
  box and the click-jump on a real diagram needs a dev host (or a real
  window) with `hackerMarkdown.plantuml.server` set and the locally-built
  server running (sections 3d/3e in `how-to-test.md`); the salt mockup
  mappings were verified live on the user's window (see the plan doc
  `docs/plans/2026/08/18/2026-08-18-plantuml-salt-cursor-sync.md`).
- For scroll-event timing traps when testing this, see the "Chromium scroll
  behavior" section in `quirks.md`.

Back to [`architecture.md`](architecture.md).
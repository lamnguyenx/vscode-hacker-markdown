# All Features

Deep technical detail lives in [architecture.md](architecture.md); sync internals
in [editor-preview-sync.md](editor-preview-sync.md).

## Placement

- **Dockable preview** — lives in a Webview View; drag the header to any
  sidebar / panel container to re-dock it.
- **Open in Editor** — opens a second preview in the editor area, to the side.
- **Survives window reloads** — the editor-area preview is serializable: it
  survives a window reload and can be dragged to another window ("Move Editor
  to New Window"), re-opening the same document. The webview persists the
  document URI via `acquireVsCodeApi().setState`.
- **`retainContextWhenHidden`** — both the docked view and editor panel use
  `retainContextWhenHidden: true`, so the webview state survives being hidden
  without re-initializing.

## Rendering

- **Follows the active editor** — re-renders on save by default, or live
  (debounced 300ms) as you type (`hackerMarkdown.renderOnSave`).
- **Pin (lock) the preview** — the toolbar pin button freezes the preview on
  the current document; editor switches don't change it. The pin releases
  **automatically when the pinned document's last tab closes** (tracked via
  `onDidChangeTabs`, not the delayed `onDidCloseTextDocument`).
- **Contributed preview extensions** — `markdown.previewScripts` /
  `previewStyles` load, so mermaid renders and KaTeX math is styled.
- **User styles & font settings** — `markdown.styles`,
  `markdown.preview.fontFamily` / `fontSize` / `lineHeight`, plus
  `hackerMarkdown.styles`. Accepts `file://` URIs, absolute paths, `https://`
  URLs, workspace-relative `/` paths, and relative paths (resolved against the
  Markdown file's folder). All with mtime cache-busting.
- **Cache-busted assets** — CSS/JS served from `build/` are appended with the
  file's modification time (`?v=…`) so a rebuilt page never serves stale assets.

## Sync

- **Bidirectional scroll sync** — togglable (`hackerMarkdown.scrollPreviewWithEditor` / `scrollEditorWithPreview`). A 1.5-second grace timer prevents echo loops between the two directions.
- **Cursor sync** — a blue outline box in the preview follows the editing
  cursor (exact line, or falls back to the containing paragraph / code fence /
  rendered diagram).
- **Click-to-source** — clicking a rendered block moves the editor cursor to
  the matching source line (preserving preview focus). A SALT mockup inside an
  inlined PlantUML SVG selects the **exact source range** that produced it.
  Modifier-key clicks are excluded (Alt drives pan/zoom; drag-release clicks
  from pan/zoom are filtered out via mouse-move distance).

## Links

- **Clickable links** — internal → editor, external → system browser,
  `#fragment` → scroll in preview.
- **Link-based file navigation** — clicking a `./other.md` link opens it in
  the editor and re-targets the preview.

## Diagrams & media

- **Pan/zoom frames for diagrams** — block-level diagram images/SVGs
  (plantuml, …) get pan/zoom with a hover toolbar (pan mode toggle, zoom
  in/out, reset). Zoom state survives re-renders, **keyed by content**
  (image src / SVG markup hash) with a 5-second TTL eviction for removed
  diagrams. Mermaid keeps its own built-in frame — never double-framed.
- **Alt+click / Ctrl+wheel zoom on frames** — Alt+click zooms in;
  Shift+Alt+click zooms out. Alt+wheel or Ctrl+wheel pinch-zooms. Pan mode
  enables Alt+drag for touchpad-friendly navigation.
- **Reading position anchor guard** — scroll position is preserved
  pixel-perfectly across re-renders. A mutation-observer-based anchor guard
  compensates for layout shifts from async diagram rendering (mermaid, KaTeX,
  PlantUML inline SVGs) for up to 10 seconds, releasing when the user scrolls
  manually.
- **Stale block keepers (anti-flicker)** — during re-renders, old diagrams are
  kept visible in place while new ones load, preventing white flashes.
- **PlantUML without the plantuml extension** — `puml`/`plantuml`/`uml`
  fences render as PlantUML-server images (SVG for most types, PNG for Ditaa).
  Set `hackerMarkdown.plantuml.server`; defaults to `http://localhost:9274`
  (the repo's docker-compose stack). Scoped to this preview only — the
  stock preview is untouched.
- **PlantUML `!include` / `!includesub` resolution** — `!include` directives
  resolve relative to the Markdown file's folder, plus configurable
  `hackerMarkdown.plantuml.includepaths`. Includes **include-loop detection**
  with a diagnostic error message.
- **PlantUML multi-page diagrams** — diagrams with `newpage` directives render
  as multiple images (one per page).
- **PlantUML `!pragma sourceFile` auto-injection** — the extension
  automatically injects `!pragma sourceFile <path>` into the diagram source
  sent to the server, enabling per-SALT-block `data-source-code` ranges for
  click-to-source on individual mockup elements.
- **PlantUML SVG inlining** — diagram SVGs are fetched server-side (no CORS)
  and inlined into the preview DOM so the webview can read the server's
  `data-source-code` salt ranges for cursor highlight and click-to-source.
  Failed fetches keep the original `<img>` (graceful degradation).
- **Graceful degradation on server failure** — no server configured → an
  in-preview error notice with an "Open Settings" button and a collapsible
  diagram source view.
- **Code-server fallback rendering** — a fallback regex handles the case where
  the mermaid extension's highlight override breaks `<pre><code>` fence
  wrapping on code-server, ensuring PlantUML still renders correctly.
- **Diagram type auto-detection** — automatically detects UML/Ditaa/Dot/
  Gantt/Salt from `@start…` markers. Ditaa renders as PNG; everything else
  as SVG.
- **PlantUML code completion** — `@start…`/`@end…`, keywords,
  `!include`/`!define`, `skinparam` names and colors are suggested inside
  puml fences (`hackerMarkdown.completions.enabled`). All `@start`/`@end`
  diagram types (`@startjson`, `@startgantt`, …) and preprocessor directives
  (`!function`, `!includesub`, `!assert`, …) are included. Dynamic procedure
  names (`SALT`, `_sample_row_empty`) defined in the current document are also
  suggested, with both bare and `_`-prefixed forms. Completion triggers on
  `@`, `!`, and `(`.
- **PlantUML go-to-definition & find-references** — F12 / Alt+Click on a
  `SALT(alias)` inside a puml fence jumps to the matching `!procedure`
  definition. Shift+F12 shows all call sites plus the definition.
- **PlantUML hover** — hovering over a procedure alias or `SALT(alias)` shows
  the `!procedure` signature, reference count, and line number.
- **PlantUML rename** — F2 on a procedure alias renames all `SALT(alias)` calls
  and the `!procedure _alias()` definition in the same fence.
- **PlantUML document highlights** — clicking a procedure alias highlights all
  occurrences (definition + invocations) in the fence, with distinct Write/Read
  kinds.
- **PlantUML code lens** — "N references" shown above each `!procedure`
  definition; click to open the references peek view.
- **PlantUML folding** — `!procedure … !endprocedure` blocks are foldable in
  the editor.
- **PlantUML syntax highlighting** — `.puml`/`.plantuml`/`.wsd`/`.pu`/`.iuml`
  files and PlantUML code fences inside Markdown are highlighted in the
  editor (TextMate grammars vendored from
  [jebbs/plantuml](https://github.com/qjebbs/vscode-plantuml), MIT).
- **Mermaid source-span reconstruction** — the mermaid markdown-it plugin
  drops `data-line` source maps; the extension rescans the document for
  `` ```mermaid `` fences and `:::mermaid` containers and re-attaches source
  spans positionally for cursor sync and click-to-source.
- **Media toolbar controls** — the preview toolbar carries an *invert media*
  dropdown (`auto`/`dark`/`light`/`off`), a *wide tables* dropdown
  (`pan`/`fit`), a *reading column width* input (any CSS length, with a
  reset to `100%`), and a *zoom* stepper group (`[−] [100%] [reset]` with
  ±5% steps, clamp 50–200%). Ctrl+=/Ctrl+-/Ctrl+0 also work when the
  preview is focused. Persisted in `hackerMarkdown.media.*` settings
  (`ConfigurationTarget.Global`).
- **SALT mockup cursor highlight with SVG `vector-effect`** — SALT mockups
  inside inlined PlantUML SVGs are highlighted via injected `<rect>` overlays
  using `vector-effect: non-scaling-stroke`, so the highlight stays visually
  constant regardless of pan/zoom transforms.

## Shortcuts

- `Ctrl/Cmd+Shift+V` — toggle the Hacker Markdown preview (shadows the
  built-in preview's keybinding; `hackerMarkdown.overridePreviewShortcut`
  decides whether it opens this preview or falls back to the built-in one).
- `Ctrl+Alt+Shift+H` — open the preview.
- `Ctrl+=` / `Ctrl+-` / `Ctrl+0` — zoom in / out / reset when the preview
  webview is focused.

## Commands

| Command | Keybinding | Description |
| --- | --- | --- |
| `Hacker Markdown: Open` | `Ctrl+Alt+Shift+H` | Reveal and focus the docked preview (picks a Markdown file if none is open) |
| `Hacker Markdown: Open Preview in Editor` | — | Open a preview as an editor tab, to the side |
| `Hacker Markdown: Toggle Preview` | `Ctrl/Cmd+Shift+V` | Toggle this preview (shadows the built-in preview's keybinding) |
| `Hacker Markdown: Refresh Preview` | — | Re-render the current document |
# Features

The user-facing feature list (what used to be inlined in the README). Deep
technical detail lives in [`architecture.md`](architecture.md) (how it works,
feature deep-dives, limitations); sync internals in
[`editor-preview-sync.md`](editor-preview-sync.md).

## Placement

- **Dockable preview** — lives in a Webview View; drag the header to any
  sidebar / panel container to re-dock it.
- **Open in Editor** — opens a second preview in the editor area, to the side.
- **Survives window reloads** — the editor-area preview is serializable: it
  survives a window reload and can be dragged to another window ("Move Editor
  to New Window"), re-opening the same document.

## Rendering

- **Follows the active editor** — re-renders on save by default, or live
  (debounced) as you type (`hackerMarkdown.renderOnSave`).
- **Pin (lock) the preview** — the toolbar pin button freezes the preview on
  the current document; editor switches don't change it, and the pin releases
  when the pinned document's last tab closes.
- **Contributed preview extensions** — `markdown.previewScripts` /
  `previewStyles` load, so mermaid renders and KaTeX math is styled.
- **User styles & font settings** — `markdown.styles`,
  `markdown.preview.fontFamily` / `fontSize` / `lineHeight`, plus
  `hackerMarkdown.styles`.

## Sync

- **Bidirectional scroll sync** — togglable
  (`hackerMarkdown.scrollPreviewWithEditor` / `scrollEditorWithPreview`).
- **Cursor sync** — a blue outline box in the preview follows the editing
  cursor (exact line, or falls back to the containing paragraph / code fence /
  rendered diagram).
- **Click-to-source** — clicking a rendered block moves the editor cursor to
  the matching source line (a SALT mockup selects the exact range that
  produced it).

## Links

- **Clickable links** — internal → editor, external → system browser,
  `#fragment` → scroll in preview.
- **Link-based file navigation** — clicking a `./other.md` link opens it in
  the editor and re-targets the preview.

## Diagrams & media

- **Pan/zoom frames for diagrams** — block-level diagram images/SVGs
  (plantuml, …) get pan/zoom with a toolbar, and the zoom state survives
  re-renders (mermaid keeps its own built-in frame — never double-framed).
- **PlantUML without the plantuml extension** — `puml`/`plantuml`/`uml`
  fences render as PlantUML-server SVGs (set `hackerMarkdown.plantuml.server`;
  `!include` resolves relative to the Markdown file). Unset → an in-preview
  notice with an *Open Settings* button. Scoped to this preview only — the
  stock preview is untouched.
- **PlantUML code completion** — `@start…`/`@end…`, keywords,
  `!include`/`!define`, `skinparam` names and colors are suggested inside
  puml fences (`hackerMarkdown.completions.enabled`). All `@start`/`@end`
  diagram types (`@startjson`, `@startgantt`, …) and preprocessor directives
  (`!function`, `!includesub`, `!assert`, …) are included. Dynamic procedure
  names (`SALT`, `_sample_row_empty`) defined in the current document are also
  suggested, with both bare and `_`-prefixed forms.
- **PlantUML go-to-definition & find-references** — Alt+Click / Cmd+Click / F12
  on a `SALT(alias)` inside a puml fence jumps to the matching `!procedure`
  definition in the same fence. Shift+F12 shows all call sites plus the definition.
- **PlantUML hover** — hovering over a procedure alias or `SALT(alias)` shows
  the `!procedure` signature, reference count, and line number.
- **PlantUML rename** — F2 on a procedure alias renames all `SALT(alias)` calls
  and the `!procedure _alias()` definition in the same fence.
- **PlantUML document highlights** — clicking a procedure alias highlights all
  occurrences (definition + invocations) in the fence.
- **PlantUML code lens** — "N references" shown above each `!procedure` definition;
  click to open the references peek view.
- **PlantUML folding** — `!procedure … !endprocedure` blocks are foldable in the editor.
- **PlantUML syntax highlighting** — `.puml`/`.plantuml`/`.wsd`/`.pu`/`.iuml`
  files and PlantUML code fences inside Markdown are highlighted in the
  editor (TextMate grammars vendored from
  [jebbs/plantuml](https://github.com/qjebbs/vscode-plantuml), MIT).
- **Media toolbar controls** — the preview toolbar carries an *invert media*
  dropdown (`auto`/`dark`/`light`/`off`), a *wide tables* dropdown
  (`pan`/`fit`), and a *reading column width* input (any CSS length, with a
  reset to `100%`). Persisted in `hackerMarkdown.media.*` settings.

## Shortcuts

- `Ctrl/Cmd+Shift+V` — toggle the Hacker Markdown preview (shadows the
  built-in preview's keybinding; `hackerMarkdown.overridePreviewShortcut`
  decides what it runs).
- `Ctrl+Alt+Shift+H` — open the preview.

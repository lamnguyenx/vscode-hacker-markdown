# Architecture

How the extension is put together: the source layout ("How it works"), the
details underneath the feature list, and the product limitations.

## How it works

- `package.json` contributes a **panel view container** (`viewsContainers.panel`) and a **webview view** inside it, so the preview can be docked in the Panel, Primary Sidebar, or Secondary Sidebar.
- `src/extension.ts` registers the `WebviewViewProvider` plus the three commands (`Hacker Markdown: Open`, `Open Preview in Editor`, `Refresh Preview`).
- `src/previewManager.ts` tracks the active Markdown editor, renders via the built-in `markdown-language-features` engine (`markdown.api.render`), and drives every attached preview (docked views + editor panels).
- `src/previewHost.ts` builds the webview HTML (CSP with nonce, `markdown.css` / `highlight.css`, toolbar) and handles host messages (link clicks, scroll sync, toolbar commands). It also injects `markdown.previewScripts` / `markdown.previewStyles` contributed by other extensions (e.g. the mermaid renderer) and adds their folders to `localResourceRoots`. Webview asset URLs (the `build/*` bundle and css) are mtime-busted here (`cacheBustBuild`).
- `src/webview/**` (strict TS, bundled by esbuild → `build/index.js`) renders the HTML fragment, preserves the reading position across re-renders, reports the topmost visible line for scroll sync, and dispatches `vscode.markdown.updateContent` after each render so contributed scripts (mermaid) re-render on live edits.
- `syntaxes/` holds the editor-side PlantUML TextMate grammars (vendored from
  `jebbs/plantuml`, MIT): `plantuml.yaml-tmLanguage` is converted by
  `scripts/build-syntax.cjs` (js-yaml, dev-only) into
  `plantuml.tmLanguage.json` — the `.json` suffix matters, vscode-textmate
  picks the parser by file extension — and contributed via `languages` +
  `grammars` in `package.json`. The `codeblock.json` injection marks
  `plantuml`/`puml`/`uml` fences inside Markdown as `meta.embedded.block.plantuml` (the original only matched `plantuml`, the preview supports all three). Editor-only: the preview's highlighting comes from `markdown.api.render`, unaffected. The emitted scopes are **re-aligned onto standard TextMate families** (`keyword.other.diagram`, `variable.other.enummember.*`, `entity.name.function.*`, …) instead of jebbs's `keyword.control.*` / `support.variable.*` / `string.quoted.double.class.other`, so color themes whose rules key on the standard families (e.g. the Eink 60Hz theme's font-style/color rules) apply to fence tokens — see `docs/plans/2026/08/05/2026-08-05-plantuml-grammar-scope-alignment.md`.

## Feature deep-dives

- **Pan/zoom frames for diagrams.** Block-level diagram images and SVGs
  (plantuml, other renderers, plain images) are wrapped in a frame with the
  same interaction model as built-in mermaid diagrams: Alt+drag to pan,
  Alt+wheel (or pinch) to zoom at the cursor, Alt+click to zoom in/out; an
  auto-hiding toolbar adds pan mode, zoom in/out and reset. Zoom state
  survives re-renders (the frame state is keyed by the img `src`), and mermaid
  keeps its own frame (`.mermaid-wrapper`) — never double-framed. The framed
  media is sized to fit the frame/preview column (natural size, capped by
  `max-width: 100%`) — the `!important` cap on `.hmk-frame-content > img/svg`
  neutralizes user styles that force diagrams to `width: 100vw`, which in a
  narrow sidebar overflow the visible webview and clip the diagram's side
  edges.
- **Rendering engine.** Output comes from the built-in `markdown-language-features`
  extension via `markdown.api.render`, so the result matches the stock
  preview — front matter, `highlight.js` code highlighting, tables, and
  markdown-it plugins contributed by other extensions.
- **PlantUML in the preview.** `puml` / `plantuml` / `uml` fences render as
  PlantUML-server SVG images (png for `ditaa`), self-hosted — no
  `jebbs.plantuml` needed. Instead of contributing a global markdown-it plugin
  (which would also change the stock preview, there being no scoped engine
  hook), `previewManager.render()` post-processes the fragment *after*
  `markdown.api.render` (`src/plantuml/renderFragment.ts` → pure
  `fences.ts`): escaped fence source → deflate+encode64 (synchro.js) →
  `<img src="<server>/<svg|png>/<…>">`, one per `newpage`. Config lives in
  `hackerMarkdown.plantuml.server` / `.includepaths`; `!include` resolves
  relative to the Markdown file's folder. No server configured → each puml
  fence becomes an in-preview error notice ("PlantUML server is not set", with
  an *Open Settings* button that opens the setting via
  `workbench.action.openSettings`, and the source kept behind a `<details>`;
  styles in `main.css`, button wired by the `[data-command]` click delegate in `src/webview/main.ts`). The emitted `<img>` is a bare block child of
  `#preview`, so the pan/zoom frames and the stale-diagram imgs keeper apply
  unchanged. If `jebbs.plantuml` is also installed, its global plugin already
  turns the fence into an `<img>` inside the engine and our pass finds nothing
  to rewrite — no double-render.
- **PlantUML code completion in markdown fences.** `@start…`/`@end…`, diagram
  keywords, `!include`/`!define`/… preprocessor directives, `skinparam`
  names and colors are suggested while typing inside
  `plantuml`/`puml`/`uml` fenced blocks. VS Code has no grammar-scoped
  completion (microsoft/vscode#208862), so `src/completions/provider.ts`
  registers one `CompletionItemProvider` on the whole `markdown` language and
  self-filters: the pure `src/completions/fences.ts` scanner returns
  `undefined` outside a puml fence (the widget never pops in prose), and the
  pure `src/completions/words.ts` catalog (790 words, ported from jebbs's
  `predefined.ts`, MIT) is offered inside one. The provider computes its own
  replace range (word chars include `@ ! $ :` so `@startum`→`@startuml`),
  reads `hackerMarkdown.completions.enabled`, and is gated behind the
  `onLanguage:markdown` activation event, so it works without opening the
  preview. Scoped to markdown fences only — `.puml`/`.wsd` files are
  untouched. Keyword-only: no macros/variables.
- **Follows the active editor.** The preview switches when you open another
  Markdown file and re-renders **on save** by default
  (`hackerMarkdown.renderOnSave`), or live (debounced) as you type when the
  setting is disabled.
- **Scroll sync** is bidirectional; togglable via
  `hackerMarkdown.scrollPreviewWithEditor` / `hackerMarkdown.scrollEditorWithPreview`.
  Editor→preview scroll sync recenters: when the cursor moves, the preview
  scrolls so the highlighted block lands at the **vertical center** of the
  preview window (clamped to the page bounds when the content can't reach the
  center, e.g. near the top/bottom of a short document) — implemented in
  `src/webview/line-sync.ts#centerElement`. The render-time reading-position
  restore uses a *minimal reveal* instead, so re-renders never recenter away
  from the reader's place.
- **Cursor sync (highlight).** A blue outline box (`.hmk-cursor`) in the
  preview that follows the editing cursor
  (`hackerMarkdown.cursorPreviewWithEditor`, default on, independent of scroll
  sync). The host broadcasts the active selection line (`cursorLine` message)
  on every selection change and on doc switch; the webview
  (`src/webview/cursor.ts`) resolves it to an element in three steps:
  (1) rendered media first — an `<img>` whose `data-hmk-from`..`data-hmk-to`
  source span contains the line (added by the puml fence rewrite in
  `src/plantuml/fences.ts`, which reads the fence's `data-line` — on the inner
  `<code>`, like the built-in preview's source map — and applies the same
  `endLine` math); (2) an exact `data-line` match; (3) the containing block —
  the greatest `data-line` at or above the line, innermost first (a paragraph,
  a code fence, a heading for a blank line). The highlight is re-applied after
  every re-render (renders recreate every element) and after late async
  renders (the frame-scan MutationObserver path). The box sits directly on the
  block, or on the puml `<img>` inside `.hmk-frame-content` so it scales with
  the pan/zoom transform.
- **Clickable links.** Internal links open in the editor (and re-target the
  preview), external links open in the system browser, `#fragment` links
  scroll within the preview.
- **User styles & font settings** come from the stock `markdown.styles`,
  `markdown.preview.fontFamily` / `fontSize` / `lineHeight` settings.

## Limitations

- The editor-area preview is a separate `WebviewPanel` instance (views cannot move into the editor area; see `viewsExtensionPoint.ts` — a view id can only be registered in one container).
- Rendering happens through `markdown.api.render`, which cannot rewrite relative image paths, so image `src` attributes are rewritten extension-side against the document folder (same behavior as the built-in preview's resource provider).
- PlantUML fences are rewritten from the rendered HTML fragment, so the fence source takes the HTML-escape round-trip (only `& < > "`; `&amp;` is decoded last to keep literal `&lt;` intact), and the generated `<img>` carries no `data-line` (scroll-sync granularity for that block; position-based re-render keepers are unaffected). The server must be CSP-compatible (`https`, or `http://` on `localhost`/`127.0.0.1`), same as the stock preview.
- Contributed preview scripts and styles are loaded (mermaid, KaTeX, …), but the extension has no control over *when* other extensions activate; a script contributed by an extension that never activates simply never loads. `markdown.css` / `highlight.css` are copied from `microsoft/vscode` (MIT) to keep rendering identical to the stock preview.
- Completions are a **static keyword list**, scoped to markdown fences. No
  macros/variables (unlike jebbs's `.puml`-file-only completion), no jar-backed
  full list, and the `plantuml`-language files get nothing. Typing plain
  letters relies on the editor's `quickSuggestions`; the `@`/`!` triggers and
  `Ctrl+Space` always work.
- Cursor sync is a **highlight only.** Rendered blocks from renderers we don't
  rewrite (mermaid via contributed `markdown.previewScripts`, `jebbs.plantuml`'s
  in-engine `<img>`) carry no `data-hmk-*` span, so a cursor *inside* such a
  fence falls back to the containing block above the media. The highlight maps
  against the rendered (possibly stale under `renderOnSave`) document, and
  moving the cursor does not scroll unless `scrollPreviewWithEditor` is also
  on.

For how these internals interact with the test pipeline, see
[`docs/important/how-to-test.md`](how-to-test.md); for generalized tool and
webview behavior, see [`docs/important/quirks.md`](quirks.md). Back to the
[`README`](../../README.md).

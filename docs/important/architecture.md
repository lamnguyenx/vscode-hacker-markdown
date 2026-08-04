# Architecture

How the extension is put together: the source layout ("How it works"), the
details underneath the feature list, and the product limitations.

## How it works

- `package.json` contributes a **panel view container** (`viewsContainers.panel`) and a **webview view** inside it, so the preview can be docked in the Panel, Primary Sidebar, or Secondary Sidebar.
- `src/extension.ts` registers the `WebviewViewProvider` plus the three commands (`Hacker Markdown: Open`, `Open Preview in Editor`, `Refresh Preview`).
- `src/previewManager.ts` tracks the active Markdown editor, renders via the built-in `markdown-language-features` engine (`markdown.api.render`), and drives every attached preview (docked views + editor panels).
- `src/previewHost.ts` builds the webview HTML (CSP with nonce, `markdown.css` / `highlight.css`, toolbar) and handles host messages (link clicks, scroll sync, toolbar commands). It also injects `markdown.previewScripts` / `markdown.previewStyles` contributed by other extensions (e.g. the mermaid renderer) and adds their folders to `localResourceRoots`. Media URLs are mtime-busted here (`cacheBustMedia`).
- `media/index.js` renders the HTML fragment, preserves the reading position across re-renders, reports the topmost visible line for scroll sync, and dispatches `vscode.markdown.updateContent` after each render so contributed scripts (mermaid) re-render on live edits.

## Feature deep-dives

- **Pan/zoom frames for diagrams.** Block-level diagram images and SVGs
  (plantuml, other renderers, plain images) are wrapped in a frame with the
  same interaction model as built-in mermaid diagrams: Alt+drag to pan,
  Alt+wheel (or pinch) to zoom at the cursor, Alt+click to zoom in/out; an
  auto-hiding toolbar adds pan mode, zoom in/out and reset. Zoom state
  survives re-renders (the frame state is keyed by the img `src`), and mermaid
  keeps its own frame (`.mermaid-wrapper`) — never double-framed.
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
  relative to the Markdown file's folder. No server configured → the fence
  stays an ordinary code block. The emitted `<img>` is a bare block child of
  `#preview`, so the pan/zoom frames and the stale-diagram imgs keeper apply
  unchanged. If `jebbs.plantuml` is also installed, its global plugin already
  turns the fence into an `<img>` inside the engine and our pass finds nothing
  to rewrite — no double-render.
- **Follows the active editor.** The preview switches when you open another
  Markdown file and re-renders **on save** by default
  (`hackerMarkdown.renderOnSave`), or live (debounced) as you type when the
  setting is disabled.
- **Scroll sync** is bidirectional; togglable via
  `hackerMarkdown.scrollPreviewWithEditor` / `hackerMarkdown.scrollEditorWithPreview`.
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

For how these internals interact with the test pipeline, see
[`docs/important/how-to-test.md`](how-to-test.md); for generalized tool and
webview behavior, see [`docs/important/quirks.md`](quirks.md). Back to the
[`README`](../../README.md).

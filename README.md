# Hacker Markdown

A Markdown preview you can **dock in the Panel or the Primary Sidebar**, or open in the Editor — unlike the built-in preview, which is locked to the editor area.

## Features

- **Dockable preview**: lives in a Webview View inside a Panel container. Drag the view header to any sidebar / panel container to re-dock it (Primary Sidebar, Secondary Sidebar, Panel).
- **Open in Editor**: `Hacker Markdown: Open Preview in Editor` opens a second preview in the editor area (`ViewColumn.Beside`).
- **Built-in rendering engine**: renders through the built-in `markdown-language-features` extension (`markdown.api.render`), so output comes from the same engine as the stock preview — front matter, `highlight.js` code highlighting, tables, and markdown-it plugins contributed by other extensions.
- **Follows the active editor**: switches when you open another Markdown file; updates live (debounced) as you type.
- **Scroll sync** (bidirectional, like the built-in preview; togglable via `hackerMarkdown.scrollPreviewWithEditor` / `hackerMarkdown.scrollEditorWithPreview`).
- **Clickable links**: internal links open in the editor, external links open in the system browser, `#fragment` links scroll within the preview.
- **User styles & font settings** from the stock `markdown.styles`, `markdown.preview.fontFamily/fontSize/lineHeight` settings.
- **Link-based file navigation**: clicking a `./other.md` link in the preview opens that file in the editor and re-targets the preview to it.

## Commands

| Command | Description |
| --- | --- |
| `Hacker Markdown: Open` | Reveal and focus the docked preview (picks a Markdown file if none is open) |
| `Hacker Markdown: Open Preview in Editor` | Open a preview as an editor tab, to the side |
| `Hacker Markdown: Refresh Preview` | Re-render the current document |

## Install & run (development)

```sh
npm install
npm run compile
```

Press `F5` in VS Code (a `Run Extension` launch config is provided), or launch
an Extension Development Host manually:

```sh
code --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost" \
     --remote-debugging-port=9335 --new-window --disable-extensions tests/workspace/test.md
```

The preview appears in the bottom Panel under the "Hacker Markdown" tab. Drag its header to the Primary Sidebar if you prefer it there (in a fresh profile, toggle the panel once with `Cmd+J` so the container switcher appears).

## How it works

- `package.json` contributes a **panel view container** (`viewsContainers.panel`) and a **webview view** inside it.
- `src/extension.ts` registers the `WebviewViewProvider` plus the three commands.
- `src/previewManager.ts` tracks the active Markdown editor, renders via the built-in engine, and drives every attached preview (docked views + editor panels).
- `src/previewHost.ts` builds the webview HTML (CSP with nonce, `markdown.css` / `highlight.css`, toolbar) and handles host messages (link clicks, scroll sync, toolbar commands).
- `media/index.js` renders the HTML fragment, preserves the reading position across re-renders, and reports the topmost visible line for scroll sync.

## Testing

See [docs/important/how-to-test.md](docs/important/how-to-test.md) for the CDP-based end-to-end pipeline (same approach as the [hacker browser](https://github.com/lamnguyenx/vscode-hacker-browser) project). With the dev host from above running on port 9335:

```sh
node tests/open_view.cjs 9335   # dismiss onboarding, open the view
node tests/test_preview.cjs 9335  # 13-check functional smoke test (all passing)
```

## Limitations

- The editor-area preview is a separate `WebviewPanel` instance (views cannot move into the editor area; see `viewsExtensionPoint.ts` — a view id can only be registered in one container).
- Rendering happens through `markdown.api.render`, which cannot rewrite relative image paths, so image `src` attributes are rewritten extension-side against the document folder (same behavior as the built-in preview's resource provider).
- Contributed preview *scripts* (e.g. KaTeX runtime for math) are not loaded — math is rendered by the engine's markdown-it plugin but without the contributed stylesheet/script, so it may not be styled. The contributed `previewStyles` from other extensions are also not included.
- `markdown.css` / `highlight.css` are copied from `microsoft/vscode` (MIT) to keep rendering identical to the stock preview.

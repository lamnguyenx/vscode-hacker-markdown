# Hacker Markdown

A Markdown preview you can **dock in the Panel or the Primary Sidebar**, or open in the Editor — unlike the built-in preview, which is locked to the editor area. It renders through the built-in `markdown-language-features` engine, so the output matches the stock preview (front matter, `highlight.js`, tables, contributed markdown-it plugins).

## Features

- **Dockable preview** — lives in a Webview View; drag the header to any sidebar / panel container to re-dock it.
- **Open in Editor** — opens a second preview in the editor area, to the side.
- **Follows the active editor** — re-renders on save by default, or live (debounced) as you type.
- **Bidirectional scroll sync** — togglable.
- **Cursor sync** — a blue outline box in the preview follows the editing
  cursor (exact line, or falls back to the containing paragraph / code fence /
  rendered diagram).
- **Clickable links** — internal → editor, external → system browser, `#fragment` → scroll in preview.
- **Contributed preview extensions** — `markdown.previewScripts` / `previewStyles` load, so mermaid renders and KaTeX math is styled.
- **Pan/zoom frames for diagrams** — block-level diagram images/SVGs (plantuml, …) get pan/zoom with a toolbar, and the zoom state survives re-renders (mermaid keeps its own built-in frame — never double-framed).
- **PlantUML without the plantuml extension** — `puml`/`plantuml`/`uml` fences render as PlantUML-server SVGs (set `hackerMarkdown.plantuml.server`; `!include` resolves relative to the Markdown file). Unset → an in-preview notice with an *Open Settings* button. Scoped to this preview only — the stock preview is untouched.
- **Link-based file navigation** — clicking a `./other.md` link opens it in the editor and re-targets the preview.
- **PlantUML syntax highlighting** — `.puml`/`.plantuml`/`.wsd`/`.pu`/`.iuml` files and PlantUML code fences inside Markdown are highlighted in the editor (TextMate grammars vendored from [jebbs/plantuml](https://github.com/qjebbs/vscode-plantuml), MIT).

## Commands

| Command | Description |
| --- | --- |
| `Hacker Markdown: Open` | Reveal and focus the docked preview (picks a Markdown file if none is open) |
| `Hacker Markdown: Open Preview in Editor` | Open a preview as an editor tab, to the side |
| `Hacker Markdown: Refresh Preview` | Re-render the current document |

## Quick start

```sh
npm install
npm run compile
```

To load it into a normal VS Code window, install it from source:

```sh
make install        # builds (npm run compile) and copies into ~/.vscode/extensions
```

then `Cmd+Shift+P > Developer: Reload Window` — see
[docs/important/how-to-install.md](docs/important/how-to-install.md) for the
full install/sync/troubleshooting guide.

For development, press `F5` in VS Code (a `Run Extension` launch config is
provided), or launch an Extension Development Host manually — see
[docs/important/how-to-test.md](docs/important/how-to-test.md#1-launch-the-extension-development-host).

## Docs

- [docs/important/how-to-install.md](docs/important/how-to-install.md) — build from source and install into VS Code (`make install`)
- [docs/important/how-to-test.md](docs/important/how-to-test.md) — end-to-end CDP test pipeline
- [docs/important/quirks.md](docs/important/quirks.md) — generalized tool / webview behaviors
- [docs/important/architecture.md](docs/important/architecture.md) — how it works, feature deep-dives, limitations

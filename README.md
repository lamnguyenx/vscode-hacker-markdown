# Hacker Markdown

A Markdown preview you can **dock in the Panel or the Primary Sidebar**, or open in the Editor — unlike the built-in preview, which is locked to the editor area. It renders through the built-in `markdown-language-features` engine, so the output matches the stock preview (front matter, `highlight.js`, tables, contributed markdown-it plugins).

See **[all-features.md](docs/important/all-features.md)** for the full feature list and [architecture.md](docs/important/architecture.md) for how it works.

## Commands

| Command | Keybinding | Description |
| --- | --- | --- |
| `Hacker Markdown: Open` | `Ctrl+Alt+Shift+H` | Reveal and focus the docked preview (picks a Markdown file if none is open) |
| `Hacker Markdown: Open Preview in Editor` | — | Open a preview as an editor tab, to the side |
| `Hacker Markdown: Toggle Preview` | `Ctrl/Cmd+Shift+V` | Toggle this preview (shadows the built-in preview's keybinding) |
| `Hacker Markdown: Refresh Preview` | — | Re-render the current document |

## Preview controls

The pinned toolbar (and the editor preview) carries four controls, persisted in
`hackerMarkdown.media.*` settings:

- **Invert media** — `auto` (follow the theme), `dark`, `light`, `off`.
- **Wide tables** — `pan` (each table scrolls horizontally with columns kept on
  one line) or `fit` (cells wrap to the reading column; long inline code, URLs
  and paths break so a narrow sidebar never clips the right-hand columns).
- **Reading column width** — any CSS length (`700px`, `45vw`, `100%`), with a
  reset button.
- **Zoom** — 50–200% in 5% steps; `Ctrl+=` / `Ctrl+-` / `Ctrl+0` also work.

Fit mode falls back to an internal scroll region when a table cannot fit even
after wrapping (for example at 200% zoom), so table text is never clipped.

## Quick start

```sh
npm install
npm run compile
```

To load it into a normal VS Code window, install it from source:

```sh
make install      # build + install into VS Code and code-server
```

then `Cmd+Shift+P > Developer: Reload Window` — see
[docs/important/how-to-install.md](docs/important/how-to-install.md) for the
full install/sync/troubleshooting guide.

For development, press `F5` in VS Code (a `Run Extension` launch config is
provided), or launch an Extension Development Host manually — see
[docs/important/how-to-test.md](docs/important/how-to-test.md#1-launch-the-extension-development-host).

## Docs

- [all-features.md](docs/important/all-features.md) — comprehensive feature list
- [architecture.md](docs/important/architecture.md) — how it works, feature deep-dives, limitations
- [how-to-install.md](docs/important/how-to-install.md) — build from source and install (`make install`)
- [how-to-test.md](docs/important/how-to-test.md) — end-to-end CDP test pipeline
- [editor-preview-sync.md](docs/important/editor-preview-sync.md) — cursor highlight + scroll sync internals
- [quirks.md](docs/important/quirks.md) — generalized tool / webview behaviors
- [native-vs-remote-ssh-vscode.md](docs/important/native-vs-remote-ssh-vscode.md) — working on this repo over Remote-SSH / dev containers

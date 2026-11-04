# Hacker Markdown

A Markdown preview you can **dock in the Panel or the Primary Sidebar**, or open in the Editor — unlike the built-in preview, which is locked to the editor area. It renders through the built-in `markdown-language-features` engine, so the output matches the stock preview (front matter, `highlight.js`, tables, contributed markdown-it plugins).

## Commands

| Command | Keybinding | Description |
| --- | --- | --- |
| `Hacker Markdown: Open` | `Ctrl+Alt+Shift+H` | Reveal and focus the docked preview (picks a Markdown file if none is open) |
| `Hacker Markdown: Open Preview in Editor` | — | Open a preview as an editor tab, to the side |
| `Hacker Markdown: Toggle Preview` | `Ctrl/Cmd+Shift+V` | Toggle this preview (shadows the built-in preview's keybinding) |
| `Hacker Markdown: Refresh Preview` | — | Re-render the current document |

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
[docs/important/install/how-to-install.md](docs/important/install/how-to-install.md) for the
full install/sync/troubleshooting guide.

For development, press `F5` in VS Code (a `Run Extension` launch config is
provided), or launch an Extension Development Host manually — see
[docs/important/testing/how-to-test.md](docs/important/testing/how-to-test.md#1-launch-the-extension-development-host).

## Docs

### [Features](docs/important/features/)

- [All features](docs/important/features/all-features.md): the complete feature list, including placement, rendering, media controls, and language features.
- [Preview controls](docs/important/features/preview-controls.md): invert media, wide tables, reading-column width, and zoom.
- [Features (superseded)](docs/important/features/features.md): pointer to `all-features.md`; kept for old links.

### [Internals](docs/important/internals/)

- [Architecture](docs/important/internals/architecture.md): how the extension is put together, feature deep-dives, and limitations.
- [Editor ↔ preview sync](docs/important/internals/editor-preview-sync.md): cursor highlight, recentering, and reverse scroll sync.
- [Quirks](docs/important/internals/quirks.md): generalized tool / webview behaviors and the workarounds.

### [Install](docs/important/install/)

- [How to install](docs/important/install/how-to-install.md): build from source, install, and keep the running copy in sync.
- [Native vs Remote-SSH VS Code](docs/important/install/native-vs-remote-ssh-vscode.md): which `code` binary can run the dev host, and why.

### [Testing](docs/important/testing/)

- [How to test this extension](docs/important/testing/how-to-test.md): the end-to-end CDP test pipeline, gotchas, and known limits.

## Elsewhere

- Dated design logs: [`docs/plans/`](docs/plans/).
- Bug write-ups: [`docs/issues/bugs/`](docs/issues/bugs/).
- Feature requests: [`docs/issues/feature-requests/`](docs/issues/feature-requests/).

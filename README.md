# Hacker Markdown

A Markdown preview you can **dock in the Panel, Primary Side Bar, or Secondary
Side Bar**, open in the Editor, move to a new window, or **toggle over the
Markdown tab in place** — unlike the built-in preview, which is locked to the
editor area. It renders through the built-in `markdown-language-features`
engine, so the output matches the stock preview (front matter, `highlight.js`,
tables, contributed markdown-it plugins).

## Commands

| Command | Keybinding | Description |
| --- | --- | --- |
| `Hacker Markdown: Open in Panel` | `Ctrl+Alt+Shift+H` | Reveal and focus the preview in the Panel (picks a Markdown file if none is open) |
| `Hacker Markdown: Open in Primary Side Bar` | — | Reveal the preview in the Primary Side Bar |
| `Hacker Markdown: Open in Secondary Side Bar` | — | Reveal the preview in the Secondary Side Bar |
| `Hacker Markdown: Open Preview in Editor` | — | Open a preview as an editor tab, to the side |
| `Hacker Markdown: Open Preview in New Window` | — | Open the in-place preview tab and move it into a new window |
| `Hacker Markdown: Toggle Preview` | `Ctrl/Cmd+K Ctrl/Cmd+V` · `Ctrl/Cmd+Shift+V` | Toggle the preview over the same Markdown tab (shadows the built-in preview's shortcut while `hackerMarkdown.overridePreviewShortcut` is enabled) |
| `Hacker Markdown: Show Source` | — | Reopen the active preview tab as the Markdown source |
| `Hacker Markdown: Refresh Preview` | — | Re-render the current document |

The command palette shows the full category-qualified names above. Menus, the
editor-tab context menu, and the editor-title tooltip use the short labels
(`Toggle Preview`, `Show Source`, …).

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
- [Placement & in-place toggle](docs/important/features/placement-and-toggle.md): Panel / Primary / Secondary Side Bar / Editor / new window, the same-tab `Toggle Preview` custom editor, and the icon-only editor action with short menu labels.
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

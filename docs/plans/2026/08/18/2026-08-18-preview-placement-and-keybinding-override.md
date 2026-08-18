# Plan: Preview placement anywhere + Ctrl/Cmd+Shift+V override

**Date:** 2026-08-18
**Status:** DONE (compile green, all pure checks green; verified live on the
user's VS Code at 9333: ctrl+shift+v opens ours with the setting on and the
built-in with it off, the editor panel survives window reloads and moves to a
new window)
**Files edited:** `package.json`, `src/extension.ts`, `src/previewManager.ts`,
`src/previewHost.ts`, `src/webview/{types,main}.ts`,
`docs/important/architecture.md`

## Goal

1. **Placement anywhere.** The preview should live where the user wants:
   docked in the Panel or either Sidebar (already works — views drag between
   containers in a window), as an editor tab ("Open Preview in Editor",
   already works), and **in another window** (drag the editor tab to a new
   window / "Move Editor to New Window").
2. **Override the built-in preview shortcut.** `Ctrl/Cmd+Shift+V` currently
   runs the built-in `markdown.togglePreview`; make it open the Hacker
   Markdown preview instead, behind an option.

## Why this approach

### Placement

A `WebviewView` (docked) is window-bound — VS Code cannot move a view to
another window. Editor-area `WebviewPanel`s **can** cross windows, but only if
the extension registers a `WebviewPanelSerializer` (`onWebviewPanel:` activation
event): when the panel leaves the window (drag, `workbench.action.moveEditorToNewWindow`,
window reload), VS Code serializes the panel and the target window's extension
host restores it through the serializer. The panel's serialized *state* comes
from the webview content itself (`acquireVsCodeApi().setState()`), so the
webview persists the document it is showing (the `setDoc` message now carries
the uri) and the serializer re-opens that document, which makes the manager
follow it and re-render.

### Keybinding override

Same-key extension keybindings conflict; VS Code's resolver (`_findCommand` in
`keybindingResolver.ts`) picks the **last registered candidate whose `when`
matches**. So winning is about *registration order*, not `when` precision.
Extension keybindings are sorted by weight (`ExternalExtension(400) + idx`
where `idx` is the keybinding's 1-based index inside the extension's
`contributes.keybindings`), then by command id.

Empirically (live troubleshooting log), the built-in `markdown.togglePreview`
*and* third-party extensions (Markdown Viewer, Markdown All in One) also bind
`ctrl+shift+v`; with our single keybinding (weight 401, `hackerMarkdown.*`
sorts before `markdown*`/`markdownViewer*`) we were never the last candidate,
so a competitor always won.

Fix: contribute a harmless first keybinding (`ctrl+alt+shift+h` →
`hackerMarkdown.open`) so our `hackerMarkdown.togglePreview` becomes the 2nd
contributed binding → weight **402** > the competitors' 401 → it is the last
candidate and wins. The `when` is scoped to the markdown language family
(identical logic to the built-in's), so we only shadow the key in markdown
contexts — HTML/Python/etc. keep their own `ctrl+shift+v` bindings.

The keybinding routes to a new `hackerMarkdown.togglePreview` command, and the
`hackerMarkdown.overridePreviewShortcut` setting (default `true`) decides what
it runs: open the Hacker Markdown preview, or delegate to the built-in
`markdown.togglePreview` (preserving stock behavior when disabled).

## Design

### `package.json`

- `activationEvents`: add `onWebviewPanel:hackerMarkdown.panel` (serializer
  restore in a fresh window) and `onCommand:hackerMarkdown.togglePreview`.
- `commands`: add `hackerMarkdown.togglePreview` ("Hacker Markdown: Toggle
  Preview").
- `keybindings` (order matters — see above):
  1. `ctrl+alt+shift+h` → `hackerMarkdown.open` (weight-bump first binding);
  2. `shift+ctrl+v` (mac `shift+cmd+v`) → `hackerMarkdown.togglePreview` with
     the markdown-scoped `when` above.
- `configuration`: `hackerMarkdown.overridePreviewShortcut` (boolean, default
  `true`).

### `src/extension.ts`

- `vscode.window.registerWebviewPanelSerializer(PreviewManager.panelViewType, manager)`.
- `hackerMarkdown.togglePreview` command: setting on → `hackerMarkdown.open`
  logic (extracted into `openPreview`), off → `markdown.togglePreview`.
- `openPreview` reveals the docked view when it has been resolved once
  (`provider.isReady()`); otherwise it falls back to the editor panel so the
  shortcut always shows a preview.

### `src/previewManager.ts`

- Implements `vscode.WebviewPanelSerializer`; `deserializeWebviewPanel` calls
  the new `createEditorHost(panel)` helper (extracted from `openInEditor`),
  then opens the serialized document (`state.uri`) so the active-editor
  tracking renders it into the revived host. Unreadable uri → empty state.
- `openInEditor` reuses the existing editor panel (reveals it) instead of
  creating duplicates; the panel is tracked and cleared on dispose.

### Webview state (`src/previewHost.ts`, `src/webview/{types,main}.ts`)

- `setDoc` now carries `uri`; `main.ts` persists it with
  `vscode.setState({ uri })` on every doc switch, so a serialized panel
  restores to the right file.

## Verification

1. `npm run compile` — pass.
2. Pure checks (`plantuml_check`, `plantuml_inline_check`, `mermaid_check`,
   `plantuml_completion_check`) — pass.
3. Live on the user's VS Code (CDP 9333, trusted input + keybinding
   troubleshooting log):
   - In a markdown editor, `ctrl+shift+v` resolves to
     `hackerMarkdown.togglePreview` ("From 6 keybinding entries, matched
     hackerMarkdown.togglePreview") and opens our preview — the editor panel
     when the docked view isn't open yet.
   - With `hackerMarkdown.overridePreviewShortcut: false`, the same key runs
     the built-in preview instead (verified a built-in webview appears).
   - The editor panel survives a window reload (restored by the serializer).
   - `View: Move Editor into New Window` with the preview tab active opens a
     new window and re-creates the panel there (extension activated by
     `onWebviewPanel:`, our toolbar present in the moved panel).

## Known limitations

- The docked **view** cannot move to another window (VS Code limitation for
  `WebviewView`s) — use "Open Preview in Editor" and drag the tab instead.
- The override wins only while our keybinding is the highest-weight binding on
  the key: it depends on the weight bump (2nd contributed keybinding) and on
  no other extension contributing a 3rd+ keybinding on the same key.
- Moving a panel to a new window where the document is not open: the
  serializer opens the file from its absolute path, so it works even outside
  the workspace.

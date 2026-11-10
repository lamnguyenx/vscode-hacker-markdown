# Placement & in-place toggle

The preview can be docked in every part of the workbench that can host a view,
opened as an editor tab, moved to a new window, or toggled directly over the
Markdown tab you are editing.

## Where the preview can live

| Placement | How to open it | Implementation |
| --- | --- | --- |
| Panel | `Hacker Markdown: Open in Panel` (`Ctrl+Alt+Shift+H`), or the "Hacker Markdown" panel tab | `viewsContainers.panel` → view `hackerMarkdown.preview` |
| Primary Side Bar | `Hacker Markdown: Open in Primary Side Bar`, or the "Hacker Markdown" Activity Bar entry | `viewsContainers.activitybar` → view `hackerMarkdown.previewPrimary` |
| Secondary Side Bar | `Hacker Markdown: Open in Secondary Side Bar` | `viewsContainers.secondarySidebar` → view `hackerMarkdown.previewSecondary` |
| Editor tab | `Hacker Markdown: Open Preview in Editor` | `vscode.window.createWebviewPanel` to the side |
| New window | `Hacker Markdown: Open Preview in New Window` | In-place custom editor tab moved with `workbench.action.moveEditorToNewWindow` |

All three docked views are independent `WebviewView`s that share one
`PreviewManager`, so they render the same active document. You can still drag
any of them between containers (Panel ↔ Primary Side Bar ↔ Secondary Side Bar)
with VS Code's normal view dragging. A `WebviewView` is window-bound: use the
editor/new-window commands to move the preview across windows.

The new-window command opens a separate preview tab first, then asks VS Code to
move it. The move is fire-and-forget because some browser-based builds do not
implement the window move; the command still returns after opening the preview.

## Toggle Preview (same tab)

`Hacker Markdown: Toggle Preview` mirrors VS Code's built-in
`Markdown: Toggle Preview`: it swaps the **active Markdown tab** between the
source and a preview, without creating a second tab.

- It is implemented as a custom text editor (`viewType:
  hackerMarkdown.previewEditor`) that is reopened with the workbench's
  `reopenActiveEditorWith` command. Toggling again reopens the same tab as the
  normal text editor.
- The custom editor is bound to its document, like a normal editor tab. It
  does **not** follow the active editor, so switching files never retargets an
  existing preview tab. The docked views still follow the active editor.
- `priority: option` keeps `.md` files opening as text by default;
  `Reopen Editor With…` lists "Hacker Markdown Preview" as an alternative.

### Keybindings

| Key | Behavior |
| --- | --- |
| `Ctrl/Cmd+K Ctrl/Cmd+V` | Always toggles the Hacker Markdown preview over the active Markdown tab |
| `Ctrl/Cmd+Shift+V` | Toggles the Hacker Markdown preview while `hackerMarkdown.overridePreviewShortcut` is `true` (the default); when `false`, the built-in preview keeps this shortcut |

The webview also detects these shortcuts itself. The workbench does not receive
`Ctrl/Cmd+V` key events from a focused webview (the browser uses them for
paste), so without that handler the preview would be a one-way trip. With it,
pressing the same keys while the preview is focused toggles back to the source.

You can also return to the source from the preview toolbar's **Show Source**
button (`data-command="reopenAsSource"`) or the editor title's
`Hacker Markdown: Show Source` action.

## Behavior with other placements

- The in-place preview is a separate host from the docked views and the
  editor-area preview. All of them stay in sync with edits.
- Pinning is hidden on the in-place preview (it is already bound to its
  document); the docked/editor-panel previews keep the pin button.
- Click-to-source and cursor/scroll sync still work: a bound preview only
  responds to selections in the same document.
- Closing the source document's last tab releases a pin and returns the
  following previews to the active editor.

## Limitations

- A custom editor can only match files with a Markdown-looking extension (the
  same set the built-in preview uses: `.md`, `.markdown`, `.mdown`, …).
  Untitled or extensionless Markdown buffers fall back to the docked Panel
  preview.
- A webview view cannot be moved to another window by VS Code; use the editor
  or new-window command.
- The custom editor is intentionally per-document. Use the docked views or
  **Open Preview in Editor** when you want a preview that follows the active
  editor while you switch files.

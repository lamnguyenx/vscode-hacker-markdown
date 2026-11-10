# Fix: Toggle Preview text label & activity-bar placement menu

**Date:** 2026-11-10
**Status:** DONE (verified: `npm run test:units` all pass,
`npm run typecheck:tests` pass, `toggle_preview_ix` 3/3, `make info` reports
`hacker-markdown 2026.11.7 · current`)
**Source:** user report — the `Cmd+Shift+V` editor action rendered as a huge
`Hacker Markdown: Toggle Preview` text button on every Markdown tab, and the
activity-bar icon's right-click menu only offered "Secondary Side Bar" and
"Panel".
**Files added:** this design log
**Files edited:** `package.json` (command categories + version),
`tests/integration/toggle_preview_ix.ts`, `README.md`,
`docs/important/features/all-features.md`,
`docs/important/features/placement-and-toggle.md`,
`docs/important/internals/architecture.md`,
`docs/important/internals/quirks.md`,
`docs/important/install/how-to-install.md`,
`docs/important/testing/how-to-test.md`

## Goal

Make the `Toggle Preview` editor-title action a compact icon, keep the command
palette discoverable under its full `Hacker Markdown: …` name, and explain why
the activity-bar container menu does not offer the location it is already in.

## Symptoms & reproduction

Two separate reports, both observed on the code-server harness:

1. Open any pure Markdown file in the editor area. The editor title bar shows
   the full command title as a text button:
   `Hacker Markdown: Toggle Preview`. The user asked for an icon instead
   ("too big text bro, use icon is ok").
2. Press `Cmd+Shift+M` (bound in the user's `keybindings.json` to
   `hackerMarkdown.preview.focus`). The preview appears in the activity-bar /
   primary side-bar area. Right-clicking its icon offers only
   **Move To → Secondary Side Bar** and **Move To → Panel** — no
   "Primary Side Bar" entry. The user suspected the extension update had not
   been picked up and asked whether code-server needed a restart.

## Root cause

### 1. The long text was a stale-host fallback, not a missing icon

The installed `2026.11.6` manifest already contained:

```json
{
  "command": "hackerMarkdown.togglePreview",
  "title": "Hacker Markdown: Toggle Preview",
  "icon": "$(preview)"
}
```

and the editor title rendered the `codicon-preview` icon on a healthy host.
The window showing the long text was the same window that showed the
**"Cannot reconnect"** dialog; its extension host had been disconnected since
the previous install/reload. In that state the editor-title action fell back to
the command's `title` text.

A second, independent problem remained even on a healthy host: the command
title is the label used by every non-icon surface — the editor-tab context
menu and the command palette. The palette needs the
`Hacker Markdown: Toggle Preview` name; the context menu does not.

### 2. "Move To" lists only the other locations

VS Code's view-container context menu deliberately omits the container's
current location. When the container is in the **Primary Side Bar** (the
Activity Bar), the "Move To" submenu offers **Panel** and **Secondary Side
Bar** — exactly the user's report. The Activity Bar icon *is* the Primary Side
Bar, so there is no separate "Primary Side Bar" destination to offer.

The keybinding in question (`hackerMarkdown.preview.focus`) targets the
**Panel** preview view. If that container was previously moved to the Primary
Side Bar, focus reveals it there and the menu then shows the other two
locations. That is workbench state, not a stale extension; a code-server
restart does not change it.

## Fix

### Command metadata (`package.json`)

Keep the command palette names intact by moving the prefix into VS Code's
`category` field and shortening the `title`:

```json
{
  "command": "hackerMarkdown.togglePreview",
  "category": "Hacker Markdown",
  "title": "Toggle Preview",
  "icon": "$(preview)"
}
```

The same treatment was applied to all eight commands. Effect:

| Surface | Label |
| --- | --- |
| Command palette | `Hacker Markdown: Toggle Preview` (category + title) |
| Editor title bar | `$(preview)` icon, `aria-label="Toggle Preview (…)"` |
| Editor-tab context menu | `Toggle Preview` |
| Editor title tooltip | `Toggle Preview (Ctrl+K Ctrl+V)` |

This does not change the command IDs, keybindings, or activation events.

Version bumped `2026.11.6` → `2026.11.7` so code-server's service worker
treats the manifest as a new extension.

### Regression check (`tests/integration/toggle_preview_ix.ts`)

After opening the Markdown fixture, the suite now reads the workbench DOM and
asserts that the editor-title action is an icon:

```ts
const el = [...document.querySelectorAll('.editor-actions .action-label')]
  .find((a) => (a.getAttribute('aria-label') || '').startsWith('Toggle Preview'));
// must have codicon-preview and must not read "Hacker Markdown: ..."
```

Then it toggles source → custom-editor preview → source as before.

## Trials, errors and dead ends

1. **First hypothesis: the icon contribution was missing.** The initial
   assumption was that `editor/title` did not inherit `commands.icon` here.
   Inspecting the live workbench DOM disproved it: once the window was
   reconnected, the action was `<a class="action-label codicon
   codicon-preview" aria-label="Toggle Preview (Ctrl+K Ctrl+V)">`. The manifest
   already had the icon; the long text was the disconnected-host fallback.
2. **The user's window was literally disconnected.** The 9024 workbench showed
   "Cannot reconnect. Please reload the window." Clicking **Reload Window**
   brought the icon back and cleared the dialog. This is why the report
   disappeared after the reload we did during the investigation.
3. **The palette title and the menu label are the same field.** Shrinking
   `title` alone would have made the palette read `Toggle Preview`, losing the
   extension name. VS Code's `category` gives the palette the qualified name
   while menus keep the short title. Verified in the live palette:
   `Hacker Markdown: Toggle Preview`.
4. **Typing into the command palette dirtied `README.md`.** `Input.insertText`
   was sent before the quick-input had focus; the text landed in the active
   editor (`Toggle PreviewToggle Preview# Hacker Markdown…`) and marked the
   buffer dirty. Fixed by focusing the quick-input `<input>` and clicking it
   first; the dirty buffer was repaired by deleting the prefix and then
   `workbench.action.files.revert`. Lesson: only send text after confirming
   `document.activeElement` is the intended input.
5. **A restored custom-editor tab hung cleanup under code-server.**
   `workbench.action.closeAllEditors` and `tabGroups.close(..., true)` timed
   out while a restored `hackerMarkdown.previewEditor` tab was open. The
   custom-editor webview is not mounted under code-server, so closing it can
   wait forever. Workaround: activate the tab and run
   `reopenActiveEditorWith default` (the `Show Source` path) to turn it back
   into a normal text tab, then close it normally. Recorded in
   `quirks.md`/`how-to-test.md`.
6. **The placement menu was not stale either.** Dumping the actual menu DOM
   showed a panel container offering **Primary Side Bar** and **Secondary Side
   Bar**, while the activity-bar container offered **Panel** and **Secondary
   Side Bar**. The current location is always omitted, which proves the menu
   was reacting to the container's real location rather than a cached
   manifest.
7. **A thread of investigation was spent on `editor/title/context`.** Adding
   `shortTitle` would not help there: that menu does not pass
   `renderShortTitle`. The `category` + short `title` change is what actually
   shortens the label on every surface.
8. **The old installed version folder stays behind.** `make info` initially
   listed `2026.11.6, 2026.11.7`. `.obsolete` already marks
   `lamnguyenx.hacker-markdown-2026.11.6` for garbage collection; the new
   version is the one in `extensions.json` and is what runs. This is normal
   VS Code install hygiene, not a duplicate active extension.

## Verification

```text
npm run compile                                 → ok
npm run test:units                              → all five checks passed
npm run typecheck:tests                         → ok
bun tests/integration/toggle_preview_ix.ts 9024 → 3/3 checks passed
make info                                       → hacker-markdown 2026.11.7 current
```

Live UI assertions (code-server 9024):

- Palette: `Hacker Markdown: Toggle Preview`, `Ctrl+K Ctrl+V`.
- Editor title: `codicon-preview`, `aria-label="Toggle Preview (Ctrl+K Ctrl+V)"`.
- Editor-tab context menu: `Toggle Preview`.
- `Cmd+Shift+M` still resolves to `hackerMarkdown.preview.focus` (the Panel
  preview view; shortcut shown as `Shift+Super+M` in the palette).
- Activity-bar container menu: "Move To" shows the *other* locations only.

## Lessons learnt

- **A command `title` is a UI string for every surface.** Put the extension
  name in `category` when the palette should keep the qualified name and menus
  should stay short.
- **An icon-backed editor action can still render as text when the extension
  host is stale.** "Cannot reconnect" is the tell. Reload the window once;
  restarting code-server is not required for manifest/command changes.
- **The "Move To" menu is not a placement inventory.** It lists destinations
  other than the current one. The Activity Bar icon and the Primary Side Bar
  are the same location; if the menu shows Panel + Secondary, the container is
  already primary.
- **Verify UI claims against the rendered DOM, not just `package.json`.**
  `contributes.commands` tells you what the manifest *asks for*; the
  workbench DOM tells you what the user actually sees.
- **Under code-server, force-closing a restored custom-editor tab can hang.**
  Reopen it as a text editor (`reopenActiveEditorWith default`) instead of
  closing the webview-backed tab.
- **CDP text input needs a confirmed focus target.** A stray
  `Input.insertText` is enough to dirty a tracked fixture; check
  `document.activeElement` (or click the widget) first.
- **The palette needs the category prefix; the menu needs the short title.**
  One cannot be optimized without the other unless `category` is used.

## Follow-ups / known limits

- The three preview containers all carry the title "Hacker Markdown" and their
  auto-generated focus commands all read "Hacker Markdown: Focus on Markdown
  Preview View". Renaming the views (Panel / Primary / Secondary) would make
  the keybinding picker less ambiguous.
- The old `2026.11.6` extension folder is left for VS Code's next garbage
  collection; no manual cleanup is required.
- The "Move To" menu remains VS Code stock behavior. If the preference is to
  move the *view* into an existing container (e.g. Explorer) rather than move
  the whole container, that is the view title's **Move View** action, not the
  activity-bar icon's menu.

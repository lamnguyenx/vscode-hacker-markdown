# Plan: Media toolbar controls (invert / table pan / column width)

**Date:** 2026-08-06
**Status:** DONE (verified: `npm run compile` + dev host CDP spot-checks + `tests/test_preview.cjs` 21/21; styling shipped built-in in `src/media/media.css` — deviation 11)
**Source:** user request — quick media controls in the pinned preview toolbar, replacing
hardcoded `tests/custom.css` values.
**Files added:** `src/webview/menus.ts`
**Files edited:** `package.json`, `src/previewHost.ts`, `src/previewManager.ts`,
`src/webview/{types,main}.ts`, `src/media/main.css`, `tests/custom.css`,
`README.md`, `docs/important/architecture.md`

## Goal

Expose three media/readability controls in the Hacker Markdown preview toolbar,
persisted in **user (Global) settings**:

1. **Media invert** — dropdown `auto | dark | light | off` (auto = invert only in
   dark themes).
2. **Table width handling** — dropdown `pan | fit` (pan = each table scrolls
   horizontally inside its own region; fit = normal wrapping table).
3. **Reading column width** — free-form text input accepting any CSS length
   (`500px`, `45vw`, `100%`, …) applied live, persisted on Enter/blur, with a
   **reset** button back to `100%`.

The extension only owns the *state + controls*; the actual styling lives in the
user's `tests/custom.css`, which keys off body attributes (`data-invert`,
`data-tables`) and a CSS custom property (`--hmk-column-width`).

## Why this approach

- The webview toolbar is the right place: it is the extension's own chrome
  (`previewHost.ts` `buildHtml`), already posts `command` messages to the
  extension host, and is present in both the docked view and the editor panel.
- Settings as the backing store (`hackerMarkdown.media.*`, `ConfigurationTarget.Global`)
  means the toolbar is a *quick control* over normal VS Code settings: values
  survive reloads, sync across hosts, and can still be edited in settings.json
  (a config-change listener broadcasts the new state — no rebuild, no scroll
  loss).
- Column width as a **CSS custom property on `<html>`** (same pattern as the
  existing `markdown.preview.fontSize` override in `getSettingsOverrideStyles()`)
  lets the webview apply typed values *locally and instantly* (no host
  roundtrip per keystroke); persistence happens only on Enter/blur.
- "auto" invert resolves in **CSS** via the `vscode-dark` body class VS Code
  adds to webviews (`_refs/.../webview/browser/pre/index.html:488`), so theme
  switches apply live without a rebuild.

## Design

### Settings (`package.json` → `contributes.configuration.properties`)

| Key | Type | Default | Values |
| --- | --- | --- | --- |
| `hackerMarkdown.media.invert` | string enum | `auto` | `auto`, `dark`, `light`, `off` |
| `hackerMarkdown.media.columnWidth` | string | `100%` | any CSS length |
| `hackerMarkdown.media.tables` | string enum | `pan` | `pan`, `fit` |

### Host (`previewHost.ts` / `previewManager.ts`)

- `buildHtml()` emits the shell state so there is no flash on load:
  - `<html style="…existing overrides… --hmk-column-width: 700px">`
  - `<body … data-invert="auto" data-tables="pan">`
  - toolbar gets, rightmost after the existing action buttons:
    - an **invert dropdown**: `.hmk-menu[data-menu-key="invert"]` with 4
      `role="menuitemradio"` items (`auto`/`dark`/`light`/`off`);
    - a **tables dropdown**: `.hmk-menu[data-menu-key="tables"]` with 2 items;
    - a **column control**: `<input class="toolbar-input">` + a reset button
      (`data-command="resetColumn"`).
- `PreviewManager.onHostMessage`:
  - `case 'setMedia'` (`{ key, value }`) → validate against the enums / the
    CSS-length regex, then `update('media.<key>', value, ConfigurationTarget.Global)`.
    The resulting config-change event broadcasts state — single source of truth.
  - `case 'command'` → `resetColumn` = `setMedia('columnWidth', '100%')`.
- Config listener: `affectsConfiguration('hackerMarkdown.media')` →
  `host.post({ type: 'mediaState', invert, columnWidth, tables })` to all hosts
  (the existing `styles` branch keeps rebuilding).
- `createHost` and the `ready` message re-post `mediaState` (same re-push
  pattern as `setDocument`).

### Webview (`types.ts`, `menus.ts` new, `main.ts`)

- `HostMessage` += `{ type: 'mediaState'; invert; columnWidth; tables }`.
- `WebviewMessage` += `{ type: 'setMedia'; key: 'invert'|'columnWidth'|'tables'; value: string }`.
- `menus.ts` (new, initialized once from `main.ts`):
  - dropdown open/close: trigger toggles its panel + `aria-expanded`; outside
    click / `Esc` closes and returns focus to the trigger; item click →
    `post({ type: 'setMedia', key, value })`;
  - column input: `input` → if it matches the CSS-length regex
    (`/^\d*\.?\d+(px|vw|vh|%|rem|em|ch|ex|cm|mm|in|pt|pc|q)$/i`), apply the
    custom property locally (`document.documentElement.style.setProperty`);
    `change` (Enter/blur) → persist via `setMedia`; invalid → revert to the
    persisted value; `Esc` → revert without saving;
  - `applyMediaState(state)` → set `document.body.dataset.invert/tables`,
    the `--hmk-column-width` property, trigger titles, checked items
    (`aria-checked` + a checkmark), and the input value (skipped while the
    input is focused so a broadcast cannot clobber a draft).
- `main.ts`: handle `mediaState`; `initMenus()`; the toolbar click delegation
  skips buttons that carry `data-menu` (menu triggers are handled by `menus.ts`).

### Styling

- `src/media/main.css`: `.hmk-menu` (position relative), `.hmk-menu-panel`
  (absolute, right-aligned under the trigger, widget background/border,
  `z-index` above content), `.hmk-menu-item` (+ `:hover`, `[aria-checked="true"]`
  checkmark), `.toolbar-input` (compact, input theme colors).
- `tests/custom.css` — rewritten to react to the state:
  - column: `body { max-width: var(--hmk-column-width, 100%) !important; margin: 0 auto !important; }`
  - full-bleed media: `div.hmk-frame, div.mermaid-wrapper` 100vw trick (kept
    from the previous CSS; `overflow` stays hidden on frames so zoom still
    clips; no global `img` rule so inline images stay in flow);
  - tables: `body[data-tables="pan"] .markdown-body table { display: block;
    overflow-x: auto; width: max-content; min-width: 100% }`,
    `body[data-tables="fit"] … { display: table; width: 100% }`;
    `pre` keeps `width: max-content` (user decision);
  - invert: `body[data-invert="dark"]` and `body.vscode-dark[data-invert="auto"]`
    → `filter: invert(100%) hue-rotate(180deg)` on `.markdown-body img/svg/video`
    (scoped to `.markdown-body` so the toolbar's inline SVGs are untouched; the
    old `svg { background-color: black }` rule is dropped).

## Verification

1. `npm run compile` (strict TS, both tsconfigs).
2. Dev host: `tools/launch-devhost.sh` → `node tests/open_view.cjs 9335` →
   `node tests/test_preview.cjs 9335` (regression).
3. CDP spot-checks (`node tests/cdp_eval.cjs 9335 iframe vscode-webview:// …`):
   - both dropdowns render in the docked view and the editor panel;
   - clicking `dark`/`fit` items updates `body[data-invert]`/`body[data-tables]`
     and persists in the profile's settings.json;
   - typing `500px` + Enter sets `--hmk-column-width: 500px` and persists;
     garbage reverts; the reset button restores `100%`;
   - outside-click / `Esc` closes the menus; checkmarks track the active item;
   - invert actually inverts media in dark theme (auto) and not in light.
4. Sanity: pan/zoom frame zooming still clips (no `overflow: visible`), table
   pans inside its own region, no page-level horizontal scrollbar.

## Known limitations

- Column width is a single number for all docs (no per-document width).
- `pre` keeps page-level `max-content` when the column is narrow (user's
  explicit choice; `pre` already scrolls internally).
- Inverting is a blanket `filter` — a diagram that is *already* dark (e.g.
  dark-themed mermaid) can double-invert in `auto`/`dark` mode.
- Live typing is local to the host being typed in until Enter/blur persists it.

## Trials, errors & deviations (chronological)

11. **The styling must ship built-in.** The first cut required the user to
    register `tests/custom.css` via `hackerMarkdown.styles` for the toolbar
    toggles to have any visual effect — verified live in the user's real
    window (port 9333) that the state toggled but `filter` stayed `none`
    (`userStyleLinks: 0`). That makes the feature invisible out of the box.
    Deviation: the invert/table/column/full-bleed styling now lives in
    `src/media/media.css` (linked after `main.css` in `buildHtml`), so the
    controls work with zero configuration; user styles still load last and
    override. `auto` inversion matches `vscode-high-contrast` too (the user's
    window runs a high-contrast theme). Also fixed there: the reset button
    applies 100% locally even while the input is focused (the mediaState
    guard skips focused fields, which left the field stale after reset).

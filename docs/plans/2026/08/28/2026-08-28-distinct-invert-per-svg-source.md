# Plan: Distinct invert per SVG source (exclude Mermaid)

**Date:** 2026-08-28
**Status:** DONE
**Source:** user request — the dark-theme "invert color" filter is applied to all
SVGs alike; distinguish Mermaid / PlantUML / embedded SVG so Mermaid (often
theme-aware) stops double-inverting.
**Files edited:** `src/media/media.css`, `src/plantuml/inlineSvg.ts`,
`tests/plantuml_inline_check.cjs`

## Goal

The invert dropdown stays a single `auto | dark | light | off` control (no new
settings, no new toolbar UI). What changes:

- **Default dark-mode invert** covers plain `img`/`video`, embedded markdown
  SVGs, and PlantUML (generated diagrams with white background).
- **Mermaid** is excluded from invert by default (its diagrams are often
  theme-aware or multi-colored, so a blanket `invert()` double-inverts them).
- Per-source user-CSS hooks make all three types addressable for overrides.

## Why this approach

- All three sources are already distinguishable in the DOM:
  - **Mermaid** → wrapped by the `bierner.markdown-mermaid` extension in
    `.mermaid-wrapper` (stable convention used across `frames.ts:100`,
    `cursor.ts:92`, `source.ts:53`).
  - **PlantUML (inlined)** → the extension fetches the server SVG and inlines
    it (`inlineSvg.ts`); the failed-fetch fallback keeps the original
    `<img data-hmk-puml>`. The inlined `<svg>` currently *loses* the marker —
    `buildInlineSvg` copies only `data-hmk-from`/`data-hmk-to`.
  - **Embedded markdown SVG** → no marker at all (the "everything else" case).
- The default behavior fix therefore needs **no host/JS changes**: a single CSS
  selector narrowing (`svg` → `svg:not(.mermaid-wrapper *)`) excludes mermaid.
  All invert logic stays pure CSS, driven by the existing
  `body[data-invert]` / `body.vscode-dark[data-invert="auto"]` machinery
  (`previewHost.ts:251`, `menus.ts:148`).
- A small additive change (`data-hmk-puml` on inlined SVGs) reuses the existing
  marker name so `[data-hmk-puml]` matches *all* PlantUML media uniformly,
  which documents a stable hook for user stylesheets. This replaces the old
  test intent ("marker must not leak into output") — with the marker now
  intentional on the svg root, that assertion flips.

### `:not(.mermaid-wrapper *)` browser support

Selectors Level 4 complex `:not()` (a compound selector inside `:not()`)
shipped unflagged in Chromium 119 / Electron 29. VS Code's current Electron
baseline (`_refs/vscode`) is well past that, so current dev hosts render it.

## Design

### Change 1 — `src/media/media.css` (default behavior)

Narrow the `svg` term of the invert selector (all three theme conditions) so
mermaid descendants fall out, keeping `img`/`video` always on and every
non-mermaid SVG (PlantUML + embedded) on:

```css
.markdown-body svg
  →  .markdown-body svg:not(.mermaid-wrapper svg)
```

Applied to each of:
- `body[data-invert="dark"] …`
- `body.vscode-dark[data-invert="auto"] …`
- `body.vscode-high-contrast[data-invert="auto"] …`

No `img`/`video` terms change.

### Change 2 — `src/plantuml/inlineSvg.ts` (per-source hook)

`buildInlineSvg`: stamp `data-hmk-puml=""` onto the `<svg>` root (alongside
the existing `data-hmk-from`/`data-hmk-to` copy) so `[data-hmk-puml]` matches
both the inlined-svg and the failed-fetch-img code paths uniformly.

This is additive: default CSS does not select on it (the `svg:not(.mermaid…)`
rule already covers PlantUML via the embedded-SVG fallback). It exists so a
user can write e.g.

```css
/* PlantUML only */
.markdown-body [data-hmk-puml] { filter: invert(100%) hue-rotate(180deg); }
/* Mermaid only */
.markdown-body .mermaid-wrapper svg { filter: ...; }
/* Embedded SVG only */
.markdown-body svg:not(.mermaid-wrapper svg):not([data-hmk-puml]) { filter: ...; }
```

Documented stable hooks (no setting changes, no toolbar changes).

## Verification

1. `npm run compile` (strict TS, both tsconfigs).
2. `node tests/plantuml_inline_check.cjs` — after the one assertion update
   (the `data-hmk-puml` marker is now *expected* on the inlined svg root).
3. Dev host (`vscode_cdp …` → `tests/test_preview.cjs`): in a dark theme /
   `data-invert="dark"`, a doc containing one mermaid diagram, one plantuml
   diagram, and one raw inline `<svg>` renders the mermaid diagram untouched
   and the plantuml + embedded SVGs inverted.

## Known limitations / out of scope

- `data-invert="light"` has no CSS branch today (selecting "light" is inert);
  pre-existing, untouched.
- No per-type settings — overrides are by user CSS only (the explicit choice
  from the planning question: "single smarter setting").

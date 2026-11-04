# Preview controls

The four persisted controls in the pinned toolbar and the editor preview.

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

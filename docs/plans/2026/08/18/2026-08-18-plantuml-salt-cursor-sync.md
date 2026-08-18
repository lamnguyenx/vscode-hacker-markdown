# Plan: PlantUML salt-element cursor sync (inline SVG + `data-source-code`)

**Date:** 2026-08-18
**Status:** DONE (pure checks green; verified live on the user's VS Code at
9333 with the locally-built server: activity mockups highlight + jump to their
`SALT(x)` invocation, note mockups to their `{{salt` range, diagram framed and
clamped)
**Files added:** `src/plantuml/inlineSvg.ts`, `src/plantuml/invocations.ts`,
`src/webview/source-code.ts`, `tests/plantuml_inline_check.cjs`
**Files edited:** `src/plantuml/fences.ts`, `src/previewManager.ts`,
`src/webview/{types,cursor,source,main,stale,frames}.ts`, `src/media/main.css`,
`tests/plantuml_check.cjs`,
`docs/important/{architecture,editor-preview-sync,how-to-test}.md`

## Goal

Make cursor sync (highlight + click-to-source) work with the **new PlantUML
server** whose SVGs embed per-SALT-block source ranges as
`data-source-code="/abs/file.puml:4:1-10:1"` on the `<g>` wrapping each mockup
(see `../plantuml/../plantuml-server-salt-source-code.md` in the plantuml repo
mirror at `docs/important/`). Moving the cursor in the editor should draw the
blue box around the exact salt mockup in the activity diagram; clicking a
mockup should select the exact source lines that produced it — like
`tests/samples/enroll-flow.puml.md`.

## Why this approach

The salt ranges live **inside** the SVG. An `<img>` hides the SVG DOM, so the
webview cannot read them, and it cannot draw a box around a sub-element of an
image. The extension host therefore **fetches each diagram's SVG and inlines
it** into the fragment before posting it to the webview (`src/plantuml/inlineSvg.ts`).
The webview then sees the real `<svg>` tree: the salt `<g data-source-code>`
elements can be resolved for highlight and click.

Two preconditions made this work end-to-end against the real server
(`plantuml/plantuml-server:jetty` on port 9274 with the locally built jar):

1. **The server only emits `data-source-code` when it knows the source file.**
   Over HTTP the fence content arrives as a bare string, so the extension
   injects `!pragma sourceFile <markdown-path>` right after `@start…`
   (`src/plantuml/fences.ts#withSourceFilePragma`). Inert on servers that do
   not know the pragma; a user-supplied pragma is never duplicated.
2. **The ranges are 1-based and relative to the diagram source** (the fence
   content), so the webview translates them with the enclosing fence's
   `data-hmk-from` (the 0-based opening-fence line, already carried by the
   rewrite and copied onto the inlined `<svg>` root):
   `md line = fenceFrom + sourceLine - 1`.

## Design

### Host: inline the SVGs (`src/plantuml/inlineSvg.ts`, new)

- `fences.ts` now marks every generated `<img>` with `data-hmk-puml`.
- `inlinePlantumlSvgs(fragment, fetcher?)` matches those tags, fetches each
  `src` (injectable fetcher, 8 s timeout), extracts the `<svg>` root, copies
  `data-hmk-from`/`data-hmk-to` onto it, and splices it in. A failed fetch /
  non-`<svg>` body keeps the original `<img>` (graceful degradation: still
  renders as a plain image, fence-level sync still works).
- `previewManager.render()` awaits it between the puml rewrite and the mermaid
  rewrite. Fetching in the host (not the webview) avoids CORS entirely.
- The SVG's embedded interactive `<script>` bundles are inert: scripts
  inserted via `innerHTML` never execute, and the preview CSP would block them
  regardless. The server's gray-out/filter interactions do not run inside the
  preview; our own cursor box / click-to-source replace them.

### Host: procedure-rendered mockups (`src/plantuml/invocations.ts`, new)

The server emits **one mockup per distinct `SALT(x)` alias** (repeated
invocations reuse the activity node) and no range for them. `saltInvocationLines`
scans the document's puml fences and yields the first-occurrence invocation
line (0-based, absolute) per distinct target, keyed by fence opening line.
`previewManager.render()` embeds them on the inlined `<svg>` root as
`data-hmk-salts="316 318 …"` (matched via the fence's `data-hmk-from`). The
webview's `attachMockupRanges` zips them onto the rangeless `<image>`s in SVG
order (`<g data-source-code>` note mockups excluded).

### Webview: salt range parsing (`src/webview/source-code.ts`, new)

- `sourceCodeRange(el)` parses `data-source-code` (`path:startLine:startCol-endLine:endCol`)
  and returns `{ from, to }` in **0-based document lines** after adding the
  fence offset. Shared by both resolution chains.
- `mockupRange(el)` resolves either mockup kind — server-tagged notes via
  `sourceCodeRange`, activity mockups via their attached (absolute)
  `data-hmk-from`/`data-hmk-to`; `isSaltMockup(el)` distinguishes a mockup
  from the `<svg>` root's own fence span.
- `attachMockupRanges(root)` zips each `svg[data-hmk-salts]`'s lines onto its
  rangeless `<image>` mockups in SVG document order (called in `main.ts`
  after every render).

### Cursor highlight (`src/webview/cursor.ts`)

- `resolveCursorTarget` checks SALT mockups **before** the whole-diagram media
  span (the `<svg>`'s fence span would otherwise always win): an element whose
  range contains the cursor line, most specific first. Both mockup kinds are
  resolved through `mockupRange` (`src/webview/source-code.ts`): server-tagged
  notes (`data-source-code`, translated via the fence offset) and
  procedure-rendered activity mockups (`data-hmk-from`/`data-hmk-to`, absolute,
  attached by `attachMockupRanges`).
- `blockTarget` boxes a salt mockup at itself (before the frame hoist) — the
  `<g>` for notes, the `<image>` for activity mockups — so the box outlines
  the mockup inside the pan/zoom transform and scales with the diagram.
- `src/media/main.css`: the salt box drops `box-shadow` (not rendered on SVG
  content) and glows via `filter: drop-shadow`; `outline` renders on SVG in
  Chromium. The rule covers both `g[data-source-code]` and
  `svg image[data-hmk-from]`.

### Click-to-source (`src/webview/source.ts` + `src/previewManager.ts`)

- `sourceLineForClick` returns a `{ line, from?, to? }`; a salt click supplies
  the whole range.
- `main.ts` posts `{ type: 'editorLine', line, from, to }` (message contract
  extended in `src/webview/types.ts`).
- New host handler `revealEditorRange(from, to)` selects the full lines so the
  exact salt source is visible; single-line clicks still use `revealEditorLine`.

### Stale keeper (`src/webview/stale.ts`)

Top-level `<svg>` blocks now participate in the re-render stale-keeping
(`snapshotStaleBlocks` previously only caught `IMG` or containers holding
`img`/`svg` children; the inline SVG is the block itself, so it was missed).

## Verification

1. `npm run compile` (strict TS + esbuild) — **pass**.
2. `node tests/plantuml_check.cjs` — existing checks plus new `!pragma
   sourceFile` injection and `SALT` invocation scan sections — **pass**.
3. `node tests/plantuml_inline_check.cjs` — new pure check (stub fetcher):
   img→svg replacement, span copy, graceful failure, ordering — **pass**.
4. `node tests/mermaid_check.cjs`, `node tests/plantuml_completion_check.cjs` — **pass**.
5. Live-server check (port 9274, locally built jar): the shipped rewrite +
   inline pipeline on the user's `enroll-flow.puml.md` produces 20
   `data-source-code` ranges (note mockups) that translate to the correct
   lines, and 16 first-occurrence `SALT(x)` invocation lines for the activity
   mockups.
6. **Live E2E on the user's VS Code (CDP 9333, trusted input)** — all green:
   - the diagram SVG is wrapped in `.hmk-frame` and clamped to the column
     (851 px vs the raw 1808 px canvas);
   - 16/16 activity mockups carry the correct invocation lines
     (`image[data-hmk-from]` in SVG order);
   - editor cursor at line 317 → the `form_empty` mockup gets `.hmk-cursor`;
   - clicking the Dashboard mockup → the editor selection jumps to the
     `SALT(saved)` line (echo re-highlights that mockup);
   - clicking a note mockup → the exact `{{salt` block is selected
     (echo on `g[data-source-code]`).

## Known limitations

- **Procedure-rendered mockups map positionally.** The server emits one mockup
  per distinct `SALT(x)` alias (repeated invocations reuse the activity node),
  so the webview zips the rangeless mockups with the first-occurrence
  invocation lines in order. A diagram whose mockup order diverges from
  first-invocation order would map wrong; the zip degrades gracefully (excess
  mockups keep the whole-fence fallback). Note mockups always use the server's
  exact ranges.
- The salt range starts on the line *after* `{{salt` (the server's
  `EmbeddedBlock` accounting); the selection still lands on the mockup's source.
- SVG-internal interactivity (gray-out / filter / floating header) is disabled
  inside the preview by CSP; the extension's own cursor/click features replace
  it there.
- Inlining adds one server fetch per puml fence per render. Renders are
  debounced / on-save, so the cost is bounded.

## Trials, errors & deviations

1. **The `<img>` cannot expose salt ranges.** The whole feature hinges on
   inlining the SVG; the first design ("keep `<img>`, only map the fence")
   could not highlight or jump to a mockup, so it was dropped.
2. **The server emits nothing without `!pragma sourceFile`.** The sample had
   zero ranges until the pragma was injected; the extension now injects it
   itself (with the markdown file's path) when the doc is a file. Existing
   pure tests with no `docUri` stay byte-identical.
3. **`fenceSourceRange` counts body lines for the fence's end** — the pragma
   line must not leak into that count, so the pragma is added to the
   `Diagram` content only, not to the span computation.
4. **`box-shadow`/`outline` on SVG elements** — outline renders in Chromium;
   box-shadow does not, so the salt box uses a `drop-shadow` glow instead.
5. **Stale keeper missed top-level `<svg>`** — the inline SVG is the block
   itself (`child.querySelector('svg, img')` only looks at descendants), so
   `snapshotStaleBlocks` now also matches `child.tagName.toUpperCase() === 'SVG'`.
6. **The `data-hmk-puml` marker broke one existing assertion** that grepped
   for any `data-hmk-` — narrowed to `data-hmk-(?:from|to)=`.
7. **The inlined SVG was never framed → "canvas too big and clipped".**
   `frames.ts#isFrameable` compared `el.tagName !== 'SVG'`, but SVG elements
   report their tag name lowercase (`'svg'`), so the check always failed and
   the `max-width: 100%` clamp never applied — the 1808×4775 SVG overflowed
   the column. Normalized with `tagName.toUpperCase()` in `isFrameable`,
   `frameKey` and the stale snapshot.
8. **Activity mockups are not wrapped in their own `<g>`.** The server puts
   the note mockups in `<g data-source-code>` wrappers, but the activity
   mockups (`<image>` elements) sit directly in the root layout group — the
   first zip targeted `g` elements and attached the first line to the root
   group. The zip now targets the `<image>` elements themselves.
9. **Live-extension-install confusion on the user's window.** The install CLI
   forwards to the running instance; the old version dir was never replaced
   (same version). Fixed by overwriting the installed dir in place, bumping to
   `2026.8.18-2`, and reloading the window (`Developer: Reload Window`).
# Plan: port PlantUML markdown-preview rendering into Hacker Markdown (scoped)

**Date:** 2026-08-04
**Status:** DONE (verified)
**Source:** `_refs/vscode-plantuml` (`src/markdown-it-plantuml/*`, `src/plantuml/{diagram,type,urlMaker/urlMaker,plantumlURL,diagram/include}.*`) — MIT (c) 2016 jebbs
**Files added:** `src/plantuml/*` (7 files), `tests/plantuml_check.cjs`
**Files edited:** `src/previewManager.ts`, `package.json`

## Goal

Render `plantuml`/`puml`/`uml` fenced code blocks as PlantUML-server SVG images
in our preview, without requiring the `jebbs.plantuml` extension — and **scoped
to our preview only** (the stock built-in preview must be unaffected).

## Why not the built-in plugin mechanism

The built-in `markdown-language-features` engine applies markdown-it plugins
from every extension that contributes `markdown.markdownItPlugins: true` +
`extendMarkdownIt` (`markdownExtensions.ts:89-103`, `markdownEngine.ts:137-146`).
That is global: it would also render puml in the **stock preview** and every
other `markdown.api.render` consumer, and it makes our preview behave
differently depending on activation order relative to jebbs. The user chose to
keep the rendering local. There is **no scoped engine hook** (the public API is
only `markdown.api.render` / `markdown.api.reloadPlugins`), so the port
post-processes the HTML fragment returned by `markdown.api.render` *after* the
engine runs. The stock preview is never touched; we only rewrite our own copy
of the fragment.

## How the source rendering works (what we are porting)

`render.ts` builds `<img src="<server>/<svg|png>/<deflate+encode64 of source>">`
per page; `newpage` directives produce one extra image per page. Format is
`svg` for everything except `ditaa` (png). No server configured → jebbs emits a
`⚠️` placeholder `<pre>`. In our design, no server → we simply **leave the
fence as a normal code block** (no replacement).

`plantumlURL.ts` encodes via `zlib.deflateRawSync` + the synchro.js `encode64`.
`include.ts` expands `!include` / `!includesub` against search paths (the
diagram's folder + `includepaths`), stripping the included file's own
`@start`/`@end` markers.

## Design

`previewManager.render()` already calls `markdown.api.render(doc)` then
transforms the fragment per host. We insert one new transform before the host
loop (once per render, not per host):

```
fragment = rewritePumlFences(fragment, doc)
```

`rewritePumlFences` regex-scans for fenced blocks rendered as
`<pre…><code class="language-(plantuml|puml|uml)"…>…</code></pre>`, unescapes the
HTML-escaped source, builds a lean `Diagram`, and replaces the whole block with
`\n<img style="background-color:#FFF;" src="<server>/<svg|png>/<…>"` per page.
No server configured → the block is left untouched.

Config comes from new settings `hackerMarkdown.plantuml.server`
(`machine-overridable`, like jebbs) and `hackerMarkdown.plantuml.includepaths`
(`resource`). Includes resolve relative to the Markdown file's folder first,
then the configured `includepaths` (better than jebbs-in-preview, which ignores
the markdown file's folder).

### Module layout (all under `src/plantuml/`)

| File | Role | vscode dep |
| --- | --- | --- |
| `settings.ts` | read `server` / `includepaths` from `hackerMarkdown.plantuml` | yes |
| `type.ts` | `DiagramType` + `getType` (verbatim port) | no |
| `diagram.ts` | lean `Diagram`: content, lines, type, pageCount, contentWithInclude | no (structural `DiagramUri`) |
| `plantumlURL.ts` | `makePlantumlURL` + deflateRaw + `encode64` (verbatim port, synchro.js header kept) | no |
| `include.ts` | `!include` / `!includesub` expansion (`IncludeResolver` class) | no |
| `fences.ts` | **pure** HTML post-processor `rewritePumlFences(html, opts)` (regex, unescape, per-page URLs) | no |
| `renderFragment.ts` | vscode boundary: reads settings, delegates to `fences.ts` | yes |

The pure modules (`type/diagram/plantumlURL/include/fences`) never import
`vscode`, so they are unit-testable in plain Node against the real shipped
code (`tests/plantuml_check.cjs`).

### Encoding as ported

`getDiagramURIComponent` in jebbs does `String.fromCharCode(...deflateRaw)`,
which throws `RangeError` on very large diagrams (argument-count limit). The
port replaces that spread with `buffer.toString('binary')` — byte-for-byte the
same char codes (latin1), no size limit. Everything else is verbatim.

## Changes

- **`src/previewManager.ts`** — `render()`: `let fragment = await
  markdown.api.render(doc)`; `fragment = rewritePumlFences(fragment, doc)`; then
  the existing per-host `rewriteImageSources` loop (which already leaves the
  `http(s)` puml `src` untouched).
- **`package.json`** — two new configuration properties under
  `hackerMarkdown.plantuml.*`.

## What already works, no webview/media changes needed

- The `<img>` lands as a bare block child of `#preview` (same shape jebbs
  produced), so `isFrameable` wraps it in a `.hmk-frame` (pan/zoom, section
  7b–7d of the smoke suite). SVG through `<img>` scales cleanly under the
  frame's `transform: scale()`.
- Puml re-render (edit+save → new src) is the stale-diagram keeper **scenario
  B** (old img kept in-flow until the new one loads) — already implemented in
  `media/index.js`.
- CSP `img-src` already allows `https:` and `http://localhost:*` /
  `http://127.0.0.1:*` (the common dev server case).

## Verification

- `npm run compile` passes (strict TS).
- `tests/plantuml_check.cjs` — pure-logic check of the real `out/plantuml/*.js`:
  - fence infos `plantuml|puml|uml` all rewritten; `mermaid` untouched;
  - no server → HTML unchanged;
  - `svg` vs `png` (ditaa) URL paths;
  - `newpage` → one img per page;
  - URL round-trips (independent decode64+inflateRaw === original source);
  - `!include ./part.puml` expands relative to the Markdown file's folder.

### Dev-host E2E (documented, run when a PlantUML server is available)

Isolated host (fresh `exp/devhost-puml` user-data-dir → only our extension
loads; satisfies "disable all extensions in our test") with
`hackerMarkdown.plantuml.server: "http://localhost:9274"`, opened on a puml
fixture; assert the puml fence renders an `<img>` in the preview DOM wrapped in
`.hmk-frame`. The existing mermaid/puml smoke checks on the normal dev host are
unchanged (there jebbs may still render the img first; our pass finds nothing
to rewrite, so no double-render).

## Known limitations

- **HTML round-trip:** the engine escapes the fence source (`&` `<` `>` `"`);
  we unescape to reconstruct it (decode `&amp;` last so an escaped literal
  `&lt;` stays literal). Only these four entities are produced by markdown-it.
- The replacement `<img>` carries no `data-line` (per-block scroll-sync
  granularity lost there); surrounding blocks keep theirs, and the
  position-based re-render keepers are unaffected.
- Server must be reachable and CSP-compatible (`https`, or `http://` on
  localhost) — a remote plain-http server is blocked, same as stock preview.
- If the user *also* has `jebbs.plantuml` installed, its plugin turns the fence
  into an `<img>` inside `markdown.api.render` first; our regex then finds no
  `<pre>` and leaves it alone (no double-render, no change to stock behavior).

## Trials, errors & deviations (chronological)

1. **"Only in our preview" forced a redesign before any code.** The first plan
   used the sanctioned `markdown.markdownItPlugins: true` + `extendMarkdownIt`
   contribution (exactly what jebbs does, and what the repo already relies on
   for puml — how-to-test.md §3d). The user rejected it: it is global and would
   also render puml in the *stock* preview. I confirmed there is **no scoped
   engine hook** (`markdown.api` exposes only `render` / `reloadPlugins`;
   the plugin list on `MarkdownItEngine` is shared and cached per
   `markdown-language-features`). So the design pivoted to post-processing the
   fragment our preview already owns. Lesson: the "everything goes through the
   shared engine so contributed plugins apply" property cuts both ways — you
   cannot scope a markdown-it plugin.
2. **`src/plantuml` could not be unit-tested if it imported `vscode`.** The
   reference modules import `vscode` at module top level; in plain Node a
   `require('vscode')` throws. To run the *real shipped code* in
   `tests/plantuml_check.cjs` (no dev host), the pure modules
   (`type/diagram/plantumlURL/include/fences`) were separated from the vscode
   boundary (`renderFragment.ts`, `settings.ts`), includes are injected as an
   argument, and `vscode.Uri` was replaced with a structural `DiagramUri`
   interface (`{ scheme, fsPath }`) that `vscode.Uri` satisfies. Because the
   file passed a structural type where the reference passed `vscode.Uri`,
   workspaces whose markdown file is `untitled:` (no `fsPath`) simply skip
   include resolution — the URL still builds from the fence content alone.
3. **`String.fromCharCode(...deflateRawBuffer)` can throw `RangeError`.**
   jebbs spreads the whole deflated buffer into `fromCharCode`; on large
   diagrams the argument count exceeds the engine limit. Ported as
   `buffer.toString('binary')` (latin1 = byte value → char code) — identical
   output, no size cap. Verified by spot-checking round-trips, not exhaustively
   against jebbs byte-for-byte (would need a build of the reference).
4. **Strict-mode type error in the verbatim `getType` port.** `type` starts
   `undefined`; `return type;` fails `strict` ("not assignable to DiagramType").
   Fixed with `return type ?? DiagramType.UML;` — semantically identical for
   the preview path (an unrecognized/@-less diagram is not `Ditaa`, so it would
   have rendered svg anyway). Also defensively `?? ''` on the `lineTwo` regex
   tests, where the reference relied on `RegExp.test(undefined)` coercion.
5. **The include test's first assertion was wrong, and it caught it.**
   `rewritePumlFences` expanded `!include ./part.puml` correctly, but my check
   asserted the inflated source contained **no** `@start` anywhere — the main
   diagram's own `@startuml` is (correctly) part of the encoded source. The
   marker-strip only applies to the *included file's* content. Rewrote the check
   to count occurrences: exactly one `@startuml` / one `@enduml` (the main
   diagram's), and the included body present. This was a test-authoring error,
   not a port error — the re-run proved the strip works.
6. **Deliberate deviations from jebbs-in-preview** (documented above, but
   collected):
   - no server → we leave the fence as an ordinary code block; jebbs emits a
     `⚠️` placeholder `<pre>` (its message strings live in its nls bundles we
     dropped). Keeping the code block is information-preserving and needs no
     localization.
   - `!include` resolves relative to the **Markdown file's folder**; jebbs's
     markdown renderer only uses window-scoped `plantuml.includepaths`
     (it ignores `env.currentDocument`). Strictly a superset of its behavior.
   - the lean `Diagram` drops jebbs's `document`/`start`/`end`/`index`/`name`/
     `isEqual` fields — those exist for its exporter, status bar and name
     bookkeeping, none of which the URL builder needs.
   - settings live in our own `hackerMarkdown.plantuml.*` namespace (per user
     choice), not `plantuml.*`, so a jebbs install neither feeds nor conflicts
     with our config.
7. **`newpage` index handling kept jebbs's embed quirk.** Page 0 omits the
   index (`/svg/<enc>`), later pages carry it (`/svg/1/<enc>`) — jebbs notes
   this is "partially compatible with kroki". Kept verbatim; the check pins the
   exact shape so a future change is intentional.

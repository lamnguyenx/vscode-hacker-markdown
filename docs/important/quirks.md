# Quirks: Testing Webview Extensions via CDP

Reusable knowledge for working with this repo's test pipeline
(`tests/*.cjs`, `exp/*.cjs`, the harnesses in `exp/scroll-anchor-test*.html`)
and for debugging webview extensions in general. These are generalized
behaviors of the tools, not bugs in this extension — each entry says what the
quirk is, why it bites, and the workaround.

For the pipeline itself, see
[`docs/important/how-to-test.md`](how-to-test.md); for the code layout and
limitations, see [`docs/important/architecture.md`](architecture.md).

## Chromium scroll behavior

- **`scrollY` is synchronous, scroll events are not.** `window.scrollBy` /
  `scrollTo` update `window.scrollY` immediately, but the `scroll` event
  fires on the next frame. Code that does "scroll, then wait for the event"
  or "event happened, so read the position" is racy by construction.
- **Scroll events coalesce.** Multiple scrolls in the same frame produce a
  single event carrying the final position. You cannot tell "two of my
  programmatic scrolls" from "my scroll + the user's scroll" by counting
  events. To avoid fighting the user: verify the *position* you care about
  (or cancel on any scroll you did not flag), never rely on event identity.
- **Scroll anchoring (`overflow-anchor`) silently moves `scrollY`.**
  Chrome keeps visible content stable across layout changes by adjusting the
  scroll position — without any scroll event you caused. Two consequences:
  - any logic that treats "scrollY moved" as "the user scrolled" is wrong
    (it will cancel its own position restore);
  - scroll anchoring gives up when the anchored element is *removed*, which
    is exactly what async renderers do — so you cannot lean on it for
    replaced-placeholder content.
  If you implement your own anchoring, disable it (`overflow-anchor: none`
  on the scroll container) or your logic and the browser will fight.
- **`scrollTo` clamps to the max scroll.** Scrolling to an element's
  `offsetTop` in a short document silently clamps; "the element is at the
  top" assertions then measure something else entirely. Verify the viewport
  can actually reach the target (assert `scrollY` afterwards).
- **Geometry depends on the window size.** A browser restart (or user
  resize) changes `innerHeight`, which changes whether a document scrolls
  at all and where the clamp lands. Geometry-dependent harnesses must set
  an explicit viewport size and re-verify it, or the scenario silently
  degrades into a different one.

## The webview OOPIF

- The extension's HTML lives in a *child iframe inside* the webview OOPIF
  target. Every expression must reach
  `document.querySelector('iframe').contentDocument` — there is no shortcut
  and `contentWindow` from the parent is cross-origin.
- **Probing the wrong window lies silently.** The extension's scripts run
  in the *inner* iframe (`contentWindow`); evaluating in the OOPIF's outer
  frame and reading `window.x` reads the *outer* window. A marker set by
  the webview code reads as "missing" from outside — check
  `contentWindow.__marker`, not `window.__marker`, before concluding the
  webview serves stale code (this burned ~an hour as a false "cached
  index.js" investigation).
- Find the right target by *probing*: iterate `/json/list` for `type ===
  'iframe'` with a `vscode-webview://` URL and eval a marker query (this
  repo uses `.toolbar .doc-name`). Editor-area previews are separate OOPIF
  targets; distinguish them by `webSocketDebuggerUrl` (object identity does
  not survive re-fetching).
- **State pushed at host creation can be lost.** Setting `webview.html`
  starts the page load asynchronously; messages posted before the page's
  `acquireVsCodeApi` listener is ready vanish silently and nothing re-posts —
  the preview sits in the empty state forever (observed on slow startups
  where ~30 user extensions load; the smoke suite's own launch usually wins
  the race, which is why this hid for so long). Any extension that pushes
  state to a webview at creation needs the page to *pull*: the page posts a
  `ready` message on load and the host re-pushes current state (this repo:
  `src/webview/main.ts` + `previewManager.ts#onHostMessage`). Retrying "refresh"
  does NOT help if the manager never captured the document in the first
  place — the `ready` handler must re-read
  `vscode.window.activeTextEditor`, not just re-post.
- `file://` pages are unique origins: a harness HTML file cannot
  `<script src>` a sibling JS file. Serve the harness over `http://` so the
  real `build/*` assets load.

## The VS Code workbench DOM (monaco)

- **Monaco virtualizes lines.** Only the visible lines exist in the DOM
  (`.view-lines .view-line`); you cannot click a line by DOM query until it
  is rendered. Either scroll first (wheel events) and poll for the element,
  or use commands that work regardless of scroll (`Ctrl+G` Go to Line).
- **Session restore makes the editor state unpredictable.** Relaunching the
  dev host restores the previous cursor position and open files. Never
  assume "fresh launch = cursor at line 1"; navigate explicitly. Worse: the
  restored *buffers* can diverge from disk (hot exit persists unsaved
  edits), so the extension may render content the file on disk does not
  have — assert against the editor's buffer, not the file, and wipe
  `User/workspaceStorage/*/backups` when buffers must not carry over.
- **The editor may be tiny.** In a default-sized dev host the panel eats
  most of the window (observed: an editor only ~97px tall). Click targets
  computed from `getBoundingClientRect()` of `.monaco-editor` are fine, but
  layout assumptions ("the doc fits, everything is visible") are not.
- **`scrollTop = scrollHeight` can collapse rendering in a backgrounded
  window.** Setting the editor scroller to its (synthetic, multi-million-px)
  `scrollHeight` sometimes leaves the viewport rendering a single
  `.view-line` — subsequent DOM queries for lines come back empty even though
  the document has many. Use the keyboard (`Cmd+End` / `Ctrl+G`) or moderate
  incremental `scrollTop` steps to reach the bottom; avoid max-scroll as a
  "get to the end" technique.

## VS Code grammar (TextMate) loading

Knowledge for debugging `contributes.grammars` / `syntaxes/*` (this repo
vendors the PlantUML grammars; applies to any extension):

- **`scopeName` collisions are silent-ish and last-registration wins.** Two
  extensions registering the *same* `scopeName` (classic case: this repo and
  `jebbs.plantuml` both used `markdown.plantuml.codeblock` for the markdown
  code-fence injection) — the second registration overwrites the first
  (`TMScopeRegistry`), so the loser's grammar file is never used. The only
  trace is a `console.warn` ("Overwriting grammar scope name to file
  mapping…") that is easy to miss in DevTools and may not persist to
  `renderer.log`. Symptom: "works in the dev host but not in my real window"
  (where the other extension is installed). Fix: give injected grammars a
  unique scopeName (this repo: `markdown.hackermarkdown.plantuml.codeblock`).
  The other extension keeps working for its own info strings; both can inject
  into `text.html.markdown` independently.
- **A missing grammar file fails loudly, once per extension-host.** `Unable
  to load and parse grammar for scope X from file://…/syntaxes/codeblock.json
  … Unable to resolve nonexistent file` lands in `renderer.log` on every host
  start while the file is absent — a clean `grep "Unable to load and parse
  grammar"` is the fastest "is the grammar even present" check. The failure
  sticks for the host's lifetime: fixing the files requires a *real* restart
  (close/reopen the window or `Developer: Reload Window`), not just a
  re-tokenize.
- **Open editors cache tokenization.** After editing `syntaxes/*` or
  `package.json#contributes.grammars`, an already-open document keeps its old
  token colors until closed/reopened (or the extension host restarts);
  `Reload Window` alone does not always re-tokenize open documents. When a
  test says "still no highlighting after relaunch", close + reopen the
  fixture tab first.
- **Token colors are theme-dependent — inspect scopes, not colors.** A
  monochrome/eink theme maps a whole `meta.embedded.block.*` region to one
  foreground, so rendered spans collapse to a single `.mtk` class and it looks
  like "no highlighting" even though tokenization is correct. Use
  `Developer: Inspect Editor Tokens and Scopes` and read the `textmate
  scopes` list (e.g. `meta.embedded.block.plantuml > diagram.source.wsd`) as
  ground truth, not the rendered colors.
- **A theme's `tokenColors` rules key on standard scope families — align the
  grammar's scopes to the theme, don't patch the theme.** Rule scopes match by
  dotted-prefix (`keyword` matches `keyword.control.*`), so a grammar that emits
  only bespoke scopes (e.g. jebbs's `keyword.control.diagram.*`,
  `support.variable.*`, `string.quoted.double.class.other.*`) lands wherever
  the theme's generic rules leave it, and fontStyle-only design intent
  (bold/italic per family) silently misses. Re-scoping the grammar onto the
  families the theme styles (this repo: `variable.other.enummember` for
  identifiers, `keyword.other` for delimiters, `entity.name.function` for member
  signatures) is the reproducible fix. The **final** color+fontStyle is decided
  by the active theme (+ user `editor.tokenColorCustomizations.textMateRules`)
  against the scope — reproducing that offline before touching the dev host:
  feed the grammar + theme through `vscode-textmate`'s own `Theme.match`
  (see `exp/themecheck/tokenize.cjs`; decode `EncodedTokenAttributes` with the
  real bit offsets from `_refs/vscode-textmate/src/encodedTokenAttributes.ts` —
  `FOREGROUND_OFFSET=15`, `BACKGROUND_OFFSET=24` — *not* the stale `F=4/f=9`
  comment in its JSDoc header, which led to garbage decodes).
- **`make install` (this repo) must ship `syntaxes/`.** The install rule
  deliberately copies `out build syntaxes` and `test`s the three grammar
  files exist afterward — it previously dropped the folder silently, which is
  exactly how a "works in dev host, not after install" regression starts.

## Language features in embedded regions (completions in markdown fences)

Knowledge for anyone adding IntelliSense (or other language features) to an
*embedded* language region — e.g. completing keywords inside a
`` ```plantuml `` block in Markdown:

- **Completion providers are per-document-language, not per-grammar-scope.**
  VS Code has no scope-based completion (open feature request
  microsoft/vscode#208862); `registerCompletionItemProvider` selects whole
  documents by language id. An *injected grammar* that scopes the region
  (`meta.embedded.block.plantuml`) makes highlighting/bracket-color work but
  does **not** route completion providers for the embedded language — a
  provider registered for `plantuml` never fires inside a markdown fence
  (this is exactly why `jebbs.plantuml`'s `.puml`-only provider misses it).
  Workaround (this repo's `src/completions/*`): register on the host language
  (`markdown`) and self-filter in `provideCompletionItems` — return `undefined`
  when the cursor is not in the target region so the widget never pops in
  prose, and compute your own replace `range` (the host word pattern, e.g.
  markdown's, stops at `@`/`!` so a partial `@startum` would append instead
  of replace).
- **The completions themselves are served by the extension host, not the
  preview webview.** They are therefore **outside the webview OOPIF CDP
  harness** used by `tests/*.cjs` (which can only reach the browser page, not
  the extension host). To assert suggestions programmatically you must invoke
  the *command* `vscode.executeCompletionItemProvider` from the **workbench**
  CDP target (the `document` page, not a `vscode-webview://` iframe) with a
  position inside the fence — the returned `isIncomplete`/items live in the
  extension host. This repo leaves completions to a pure-logic check
  (`tests/plantuml_completion_check.cjs`) plus manual dev-host verification
  (see how-to-test.md §3g).
- **A shared cached `CompletionItem[]` cannot be returned directly.** VS Code
  mutates `item.range` per request, so returning module-level cached items
  leaks one request's range into the next (and across documents). Cache the
  labels; build fresh item objects per request and assign the computed range.

## CDP input automation

- **Trusted input only.** VS Code's keybinding service ignores synthetic
  DOM events; use `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` /
  `Input.insertText` (see `test_preview.cjs`).
- **Modifiers are flags, not key presses.** `Meta+Shift+P` works only if the
  final key event carries `modifiers: 12`. Pressing `Meta`, then `Shift`,
  then `P` as three plain key events does *nothing* to VS Code's keybindings.
- **Click coordinates must be real.** `elementFromPoint` returns `null` for
  off-viewport elements and CDP clicks silently miss — scroll the target
  into view first.
- **The palette's fuzzy matcher is ambiguous.** Typing a command prefix can
  rank a different command first; click the row whose text *starts with* the
  exact string rather than pressing Enter.
- **Focus follows the last trusted interaction.** After a link click the
  editor is focused and `Input.insertText` lands there without a click; a
  stray click can steal focus and make live-edit checks flaky.
- **Cursor placement by click needs an exact line.** Clicking the editor
  body moves the cursor somewhere; `Ctrl+G` + `End` (end of logical line)
  is the deterministic route. Inserting at column 1 of a code-block line
  merges the old content onto the inserted line — always `End` first.

## Harness design (webview logic in a plain page)

- Stub `acquireVsCodeApi()` and drive the real `build/index.js` (the
  bundled webview script; sources in `src/webview/**`) by dispatching
  `MessageEvent`s (`type: 'render'` etc.) — this tests the
  actual shipped code, not a copy.
- Isolate the logic under test: `overflow-anchor: none`, no external
  network, no contributed scripts. Browser behaviors you did not disable
  will absorb the effects you are trying to assert (and will do so
  differently depending on timing).
- Prove the harness discriminates: keep a control run with the fix disabled
  (e.g. a sed-stripped copy of the script) — it must FAIL while the fixed
  run PASSES, or the harness is asserting the wrong thing.
- Record positions/state *before* the event under test and compare after;
  re-query elements by selector each time (cached references go stale or
  get detached after DOM swaps — `getBoundingClientRect()` on a detached
  element returns zeros).
- Partial-text selectors are traps: `.find(x => x.textContent.includes('…'))`
  can match the wrong element when the phrase appears elsewhere ("…the
  diagram to anchor the reading position against…" matched instead of the
  actual note). Use a unique substring.
- `MutationObserver` callbacks are microtasks: with `await`s in the same
  script, timer registration order decides which callback runs first at a
  shared deadline — don't assume your `await` resumes before the observer's
  debounce fires.

## Contributed preview renderers (mermaid/puml/KaTeX)

Knowledge for anyone poking at the async diagram renderers this extension
integrates with:

- **`jebbs.plantuml` is a markdown-it plugin, not a `previewScripts`
  renderer.** It contributes `markdown.markdownItPlugins: true` +
  `extendMarkdownIt`, so puml fences become `\n<img style="background-color:#FFF;">`
  tags *inside* `markdown.api.render` — direct children of the preview
  container (no `<p>` wrapper, no placeholder that gets swapped later).
  Consequences: (1) any "is this image inline prose?" check that looks at
  siblings must not reject block siblings (H2/H3 next to the img) — only
  inline/phrasing containers (p/span/…) trigger the strict sibling check;
  (2) without `plantuml.server`/`plantuml.render: PlantUMLServer` configured
  it emits a `⚠️` placeholder `<pre>` with the diagram source — no `<img>` at
  all; (3) its re-render is an img reload, so keepers must be the keep-old-img
  kind, not the hold-placeholder-height kind.

- **The container's `textContent` can be the diagram source.** The built-in
  mermaid renderer reads `container.textContent` as the mermaid source.
  Anything you insert *inside* the placeholder as a DOM node becomes part
  of the diagram ("Parse error on line 7"). Overlays/badges over
  placeholders must be CSS pseudo-elements (`::after`) — invisible to
  `textContent` — or siblings.
- **Renderers replace or empty the placeholder element itself.** The
  built-in mermaid removes `.mermaid > svg`, clears `innerHTML`, renders,
  then writes the new svg back; bierner's `replaceWith`s the whole
  wrapper. A `min-height` on the placeholder dies with it — the height
  hold must live on a *wrapper div* that survives the swap.
- **`style="all: unset"` makes placeholders inline.** `offsetHeight` of an
  inline element is 0, so height filters must use
  `getBoundingClientRect().height`.
- **Edits shift `data-line` values.** Inserting a line inside a diagram
  bumps every following `data-line` by one — matching old↔new blocks by
  line *values* breaks. Match by position (count of preceding data-line
  elements + order within the gap), which is stable across edits.
- **Fast renders complete in <16ms.** A tiny diagram re-renders faster than
  a 100ms poll; the "re-rendering" state can be missed entirely. Either
  poll tightly or give the indicator a minimum visible duration.
- **Kind switches never settle.** Pairing an old container with a new img
  (or vice versa) means a min-height wrapper around an img that never
  satisfies the "content landed" observer. Only pair same-kind blocks.

## Dev host lifecycle

- **The dev host must run WITHOUT `--disable-extensions`.** The smoke
  suite's mermaid check needs `bierner.markdown-mermaid` and puml needs
  `jebbs.plantuml`; with the flag both silently degrade (mermaid: `Error:
  Tool "renderMermaidDiagram" was not contributed`; puml: plain code
  blocks). Costs of loading the real user extensions: ~30 extensions
  activate (slow startup — the preview can render *minutes* late), extra
  webview targets appear (Copilot chat, markdown-preview-enhanced's
  `lute.min.js` preview, …) — find the preview by marker, never by target
  order.
- **`Cmd+Shift+P` can silently stop opening the command palette** while
  `Cmd+P` quick open still works (cause unpinned; observed after loading all
  user extensions). Fallback that always works: `Cmd+P`, then type
  `>command name` into quick open and click the row. Don't debug the
  extension while the palette itself is broken.
- **An open editor-area preview empties every preview.** The `WebviewPanel`
  becomes the active tab when opened, and then
  `vscode.window.activeTextEditor` is `undefined` — this extension's
  follow-the-active-editor model broadcasts `empty()` to *all* hosts. After
  `Open Preview in Editor`, click back to a markdown tab before asserting
  content (the smoke suite passes only because it probes the panel before
  focus settles).
- **The smoke suite dirties tracked fixtures by design.** The live-edit
  check types into `tests/workspace/sub.md` and saves it, and a failed
  palette command leaks its typed text into the open buffer (observed: a
  stray `} O` inside a puml sample). `git checkout` the fixtures after a
  run; wipe `exp/devhost/User/workspaceStorage/*/backups` to clear hot-exit
  buffers.
- **The smoke suite is not idempotent.** It mutates host state as it goes
  (opens files, panels, editors); re-running without a fresh launch yields
  bogus failures (stray TypeErrors in probes, missing elements). Restart the
  host between runs; before debugging any failure, re-run once fresh.
- **The onboarding overlay swallows input.** Fresh profiles show a one-time
  modal that intercepts all CDP events; dismiss it first (`open_view.cjs`
  step 1). It is persisted afterwards.
- **The panel switcher renders lazily.** After launch the panel tab list may
  be empty; toggle the panel (`Cmd+J`) and poll for the tab before clicking.
- **The webview caches assets aggressively.** The extension's own webview
  assets (`build/*` — the esbuild bundle plus the `src/media` css copied
  there, served through the webview resource server + a service worker with
  ETag revalidation) can be served stale long after you edit the file —
  observed: an edited `index.js` not reloading even across dev-host
  restarts. The webview HTML must mtime-bust every asset URL
  (`previewHost.ts#cacheBustBuild`); without it, debugging webview code is
  chaos. (User *styles* were already busted; the base media were not.)
- **Verify the extension actually re-loaded your changes.** Webview assets
  (`build/*`) are served from disk, but the page only picks them up on the
  next webview load (`Refresh Preview` rebuilds it) — restart the host when
  in doubt. Remember the webview assets are built: after editing
  `src/webview/**` or `src/media/*` run `npm run compile` (or
  `npm run build:webview && npm run build:webview-assets`).
- **A launch can silently JOIN the running instance.** If a dev host with
  the same `--user-data-dir` is still alive, a new `code` invocation joins
  it instead of starting fresh — the port, the extension, and the buffers
  are all the OLD ones, and the new launch's arguments are ignored. After
  `pkill`, confirm `pgrep -fl extensionDevelopmentPath` returns 0 *before*
  launching, and treat any new log dir under
  `exp/devhost/logs/<timestamp>` as the proof a fresh window actually
  started.

# Quirks: Testing Webview Extensions via CDP

Reusable knowledge for working with this repo's test pipeline
(`tests/*.cjs`, `exp/*.cjs`, the harnesses in `exp/scroll-anchor-test*.html`)
and for debugging webview extensions in general. These are generalized
behaviors of the tools, not bugs in this extension — each entry says what the
quirk is, why it bites, and the workaround.

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
  `media/index.js` + `previewManager.ts#onHostMessage`). Retrying "refresh"
  does NOT help if the manager never captured the document in the first
  place — the `ready` handler must re-read
  `vscode.window.activeTextEditor`, not just re-post.
- `file://` pages are unique origins: a harness HTML file cannot
  `<script src>` a sibling JS file. Serve the harness over `http://` so the
  real `media/*` assets load.

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

- Stub `acquireVsCodeApi()` and drive the real `media/index.js` by
  dispatching `MessageEvent`s (`type: 'render'` etc.) — this tests the
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
- **The webview caches media aggressively.** The extension's own `media/*`
  (served through the webview resource server + a service worker with
  ETag revalidation) can be served stale long after you edit the file —
  observed: an edited `index.js` not reloading even across dev-host
  restarts. The webview HTML must mtime-bust every media URL
  (`previewHost.ts#cacheBustMedia`); without it, debugging webview code is
  chaos. (User *styles* were already busted; the base media were not.)
- **Verify the extension actually re-loaded your changes.** Webview media
  (`media/*`) is served from disk, but the page only picks it up on the next
  webview load (`Refresh Preview` rebuilds it) — restart the host when in
  doubt.
- **A launch can silently JOIN the running instance.** If a dev host with
  the same `--user-data-dir` is still alive, a new `code` invocation joins
  it instead of starting fresh — the port, the extension, and the buffers
  are all the OLD ones, and the new launch's arguments are ignored. After
  `pkill`, confirm `pgrep -fl extensionDevelopmentPath` returns 0 *before*
  launching, and treat any new log dir under
  `exp/devhost/logs/<timestamp>` as the proof a fresh window actually
  started.

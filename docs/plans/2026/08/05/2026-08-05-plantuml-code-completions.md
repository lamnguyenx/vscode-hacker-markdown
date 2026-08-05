# Plan: PlantUML code completions inside markdown `` ``` `` blocks

**Date:** 2026-08-05
**Status:** DONE (verified: `npm run compile` + `node tests/plantuml_completion_check.cjs`)
**Source:** `_refs/vscode-plantuml/src/plantuml/intellisense/languageCompletion/predefined.ts` (MIT (c) jebbs) — the static keyword catalog, ported (not the `-language` jar path).
**Files added:** `src/completions/{words,fences,provider}.ts`, `tests/plantuml_completion_check.cjs`
**Files edited:** `src/extension.ts`, `package.json`, `docs/important/{architecture,how-to-test,quirks}.md`

## Goal

Offer PlantUML code suggestions (IntelliSense) while editing inside
`plantuml`/`puml`/`uml` fenced code blocks in Markdown documents — without
requiring the `jebbs.plantuml` extension. Syntactic decision: **keywords only**
(no macro/variable parsing), **markdown fences only** (no standalone `.puml`
file registration), gated behind a toggle (`hackerMarkdown.completions.enabled`,
default on), and the extension must activate on `onLanguage:markdown` so
suggestions work without first opening the preview.

## Why this approach

VS Code has **no scope-based completion** for embedded grammar regions
(open feature request microsoft/vscode#208862). Completion providers are
registered per *document language*, so the provider must be registered on
`markdown` and filter inside `provideCompletionItems`. This is the same
pattern markdown-all-in-one uses for LaTeX math completions: return a real
list when the context matches, `undefined` otherwise.

`jebbs.plantuml` itself only registers its completion provider for the
`plantuml` language (`src/providers/completion.ts` — `{ scheme: 'file'|'untitled', language: 'plantuml' }`),
so it never fires inside markdown fences. Its `predefined.ts` language list is
pure data (typewords / keywords / preprocessor / skinparameters / colors);
we port that list verbatim (MIT, attribution header kept, same as
`src/plantuml/plantumlURL.ts` keeps the synchro.js header). jebbs *also*
generates a larger list by running the PlantUML jar (`-language`, `generating.ts`),
but that needs a local jar at runtime — out of scope; the static list is the
practical, dependency-free catalog.

## Design

### Fence detection (pure)

`src/completions/fences.ts` scans the document line-by-line from the top,
tracking fenced-block state:

- an open line is `^\s*(`{3,}|~{3,})\s*(plantuml|puml|uml)(\s.*)?$` (case-insensitive);
- a close line is `^\s*(`{3,}|~{3,})\s*$` of the same fence char;
- other-language fences (python, mermaid, …) are tracked so a puml fence
  inside the open/close range is the state we act on;
- returns `{ lang, startLine, endLine }` when the cursor line lies strictly
  inside a plantuml/puml/uml fence (open line < cursor < close line), else
  `undefined`.

Module is pure (no `vscode` import) so the real shipped code is unit-testable
in Node via `tests/plantuml_completion_check.cjs`, matching the repo's
pure-module convention (`src/plantuml/*`).

### Keyword catalog (pure)

`src/completions/words.ts` ports the four/five predefined arrays with an MIT
attribution header:

| Array | Count | CompletionItemKind |
| --- | --- | --- |
| `typewords` | 29 | Struct |
| `keywords` | 81 | Keyword |
| `preprocessor` | 12 | Function |
| `skinparameter` | 514 | Field |
| `colors` | 154 | Color |

### Provider (vscode boundary)

`src/completions/provider.ts`:

- `registerCompletions(context)` registers
  `languages.registerCompletionItemProvider({ language: 'markdown' }, provider, '@', '!')`
  (trigger chars for the two directive families: `@start…`/`@end…` and `!include`/`!define`/…).
- Inside `provideCompletionItems`:
  1. read `hackerMarkdown.completions.enabled` — `undefined` when off;
  2. `fenceAt(document.getText(), position.line)` — `undefined` when not in a puml fence;
  3. compute the replace `Range` for the current token: walk the character
     before the cursor back while it matches `[A-Za-z0-9_@!\$:.-]` so a partial
     like `@startum` or `part` is replaced wholesale;
  4. return `CompletionItem`s built once (module-level cache) with
     `insertText = word` and the kinds above.

### Behavior notes

- Trigger chars `@` / `!` auto-open the list for the two directive families;
  plain-letter typing relies on the user's default `quickSuggestions`
  (`Ctrl+Space` always works). To be verified in the dev host.
- Not in a puml fence → `undefined`, so the widget never pops in normal prose
  (typing `!` or `@` elsewhere contributes nothing from this provider).
- Markdown regex fences don't nest; the simple state machine is exact.

## Changes

- **`src/completions/words.ts`** — pure data (ported, MIT header).
- **`src/completions/fences.ts`** — pure scanner (no `vscode` import).
- **`src/completions/provider.ts`** — vscode boundary; reads config, builds items, registers provider.
- **`src/extension.ts`** — `registerCompletions(context)` in `activate()`.
- **`package.json`** —
  - `activationEvents` += `"onLanguage:markdown"`;
  - `configuration` += `hackerMarkdown.completions.enabled` (boolean, default `true`).
- **`tests/plantuml_completion_check.cjs`** — pure-logic check of
  `out/completions/*.js` (no dev host): fence detection (inside/outside, all
  three lang names, case-insensitivity, tilde+backtick fences, closed vs
  unclosed, indent, other-language fences excluded) + catalog sanity
  (`@startuml`/`@enduml`/`participant`/`!include`, a skinparam, a color).
- **Docs** — `architecture.md` feature bullet; `how-to-test.md` new check +
  quick-reference row.

## Verification

1. `npm run compile` (strict TS) and `node tests/plantuml_completion_check.cjs`.
2. Manual dev-host check: `tools/launch-devhost.sh` on a fixture with a puml
   fence; confirm suggestions inside the fence and silence outside. Completions
   live in the extension host, not the preview webview, so they are outside the
   webview-OOPIF CDP harness; full automated assertion would require invoking
   `vscode.executeCompletionItemProvider` from the workbench target (documented,
   not wired into the smoke suite).

## Known limitations

- Static catalog only — no macros (`!define`/`!function`) or document
  variables, no live jar-backed keyword list. Catalog is jebbs's predefined
  list, not the jar's full generated one.
- Scoped to markdown fences; `.puml`/`.wsd` files are untouched (the repo does
  not register a provider for the `plantuml` language).
- Requires the extension to be active: `onLanguage:markdown` activation was
  added so editing a markdown file alone activates it.
- Letter-triggered auto-suggest depends on the editor's `quickSuggestions`
  behavior inside fenced blocks; `@`/`!` triggers and `Ctrl+Space` are guaranteed.

## Trials, errors & deviations (chronological)

1. **No scope-based completion exists** — confirmed via
   microsoft/vscode#208862; the provider must be registered on `markdown` and
   self-filter. The plan mirrors markdown-all-in-one's math-completions pattern.
2. **Port the static list, skip the jar.** jebbs splits the catalog into a
   buildable jar path (`generating.ts`) and a static `predefined.ts`; we only
   need the static half. 790 items total (29+81+12+514+154) — pure data, no
   runtime cost.
3. **Kind mapping** follows jebbs's `predefined.ts` ordering exactly
   (typewords→Struct, keywords→Keyword, preprocessor→Function,
   skinparameter→Field, colors→Color).
4. **Toggle and activation** were user decisions: a `completions.enabled`
   setting (default on) and `onLanguage:markdown` activation so the feature
   works with just the extension installed.
5. **First `fenceAt` was over-complicated and wrong.** The initial scanner
   re-matched open-fence lines *inside* an open fence (treating `` ``` `` runs
   as both openers and closers in one regex pass), which double-processed
   lines and made "cursor on the closer" ambiguous. Rewrote it as a clean
   two-state machine: openers are only recognized *outside* a fence; closers
   only *inside* (same char, run ≥ the open run); the target-line checks
   (on opener / on closer → not inside) are decided inline. The checks in
   `plantuml_completion_check.cjs` (longer closing run, mismatched closer
   char, unclosed fence) pin these branches.
6. **`CompletionItemKind` enum numbers are not stable across API versions.**
   The first `words.ts` put numeric enum values directly in
   `PLANTUML_LANGUAGE_WORDS` (`kind: 18`, etc.) to keep the module "pure" —
   but those numbers shift across vscode.d.ts versions and a guessed mapping
   is unverifiable. Replaced with a stable string-kind union
   (`'struct'|'keyword'|'function'|'field'|'color'`) in the pure module and
   mapped to `vscode.CompletionItemKind.*` in the vscode boundary
   (`provider.ts`). Same purity, no version coupling.
7. **The scanner must track *every* fence, not just puml ones.** A puml
   fence nested inside an unclosed non-puml fence (e.g. a `python` block with
   a stray `` ```plantuml `` line) must NOT complete — per markdown semantics
   that line is content of the surrounding python fence, and markdown fences
   don't nest. The generic open/close state machine naturally produces this;
   added a test (`puml fence swallowed by unclosed python fence → undefined`).
8. **A shared cached `CompletionItem[]` cannot be returned directly.** VS Code
   mutates `item.range` per request, so returning the module-level cached
   items would leak one request's range into the next (and across documents).
   `provideCompletionItems` builds *fresh* item objects per request from the
   cached labels and assigns the computed `range`.
9. **The word char class exists because markdown's own word pattern would
   stop at `@`/`!`.** Without a computed replace range, a partial like
   `@startum` would be matched against markdown's word pattern and the
   suggestion would append instead of replacing. Walked backward over
   `[@!$:a-zA-Z0-9_.-]` from the cursor.
10. **Count slip in the docs.** Called the catalog "791 words" in
    `architecture.md` during drafting; the sum is 790 (29+81+12+514+154).
    Fixed in both docs; the check asserts the per-array sizes so it cannot
    drift silently.

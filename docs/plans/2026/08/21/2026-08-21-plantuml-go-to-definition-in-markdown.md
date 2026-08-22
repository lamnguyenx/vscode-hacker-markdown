# Plan: PlantUML Go-to-Definition inside markdown fences

**Date:** 2026-08-21
**Status:** DONE (pure checks green; verified live on the user's VS Code)
**Files added:** `src/completions/definitions.ts`, `tests/plantuml_definition_check.cjs`
**Files edited:** `src/plantuml/invocations.ts`, `src/extension.ts`,
`docs/important/{architecture,how-to-test,features}.md`

## Goal

Alt+Click / Cmd+Click / Ctrl+Click / **F12** on a `SALT(<alias>)` argument
inside a `plantuml`/`puml`/`uml` markdown fence jumps the editor cursor to the
matching `!procedure _<alias>()` definition in the same fence.

Example, from `tests/samples/enroll-flow.puml.md`:

- cursor on `enroll_uploading_1` inside `enroll_done_0 --> SALT(enroll_uploading_1)`
  (line 467, 1-based)
- Go-to-Definition lands on `!procedure _enroll_uploading_1()` at line 213 (1-based)

**Bonus 1 — ReferenceProvider (Shift+F12 / "Find All References"):**
When cursor is on either `enroll_uploading_1` (invocation) or
`_enroll_uploading_1` (definition), Shift+F12 shows all `SALT(enroll_uploading_1)`
call sites plus the definition line.

**Bonus 2 — "Click on definition → references" via VS Code's built-in:
Alt+Click / Ctrl+Click on `_enroll_uploading_1` in `!procedure _enroll_uploading_1()`
shows all `SALT(enroll_uploading_1)` references.** This is not custom logic — VS
Code's `editor.action.revealDefinition` handler (in
`goToCommands.ts:140`) already checks: when the only definition found is AT the
cursor position (1 result, same line), it fires the alternative command instead
(default: `editor.action.goToReferences`). So our `DefinitionProvider` returning
the definition line even when cursor is already there makes the built-in engine
display references automatically.

## Why this approach (and what's out of scope)

Same constraint that governs the completion provider
(`src/completions/provider.ts`): VS Code has **no scope-based language
features for embedded grammar regions** (microsoft/vscode#208862). An injected
grammar (`syntaxes/codeblock.json` → `meta.embedded.block.plantuml`) scopes
*highlighting*, but does **not** route a `plantuml`-registered provider into
markdown. The built-in `markdown` grammar's `wordPattern` covers plain letters,
digits and `_` — sufficient for `enroll_uploading_1` — so no custom word
extraction is needed (unlike completion's `@start…`/`!include`, which need the
wider `[@!$:a-zA-Z0-9_.-]` set).

No `package.json` changes (no new `contributes.*`, no keybinding overrides).
The `onLanguage:markdown` activation event already covers the provider.

**In scope (this plan):**

- `DefinitionProvider`, registered on the `markdown` language, self-gated by
  `fenceAt` (returns `undefined` outside puml fences — silent in prose).
- `ReferenceProvider`, same registration + gating pattern, for Shift+F12 /
  "Find All References".
- Alias → first `!procedure _<alias>()` in the **same fence**, for both
  definition and reference resolution.
- The `_` → no-`_` fallback in the DefinitionProvider: when the cursor word
  starts with `_` (indicating cursor is on the `procecure _name()` line), the
  provider strips the prefix and searches the alias map. If found, it returns
  the definition line — VS Code's core then sees "1 result at cursor" and fires
  the alternative command, showing references.

**Deferred (hard, separate plans):**

- **Cross-file via `!include` / `!includesub`.** PlantUML resolves these
  against the markdown file's folder + `hackerMarkdown.plantuml.includepaths`
  (`src/plantuml/include.ts`). A cross-file jump needs to translate the
  included file's line numbers back into a virtual markdown position — a
  virtual-doc mapping we do not have today.
- **Definition of `@start…` arrows and `participant`/`class`/`actor` names.**
  These need a proper PlantUML parser, not a scan; out of scope.

## Design

### 1. Alias map + all-invocations scan — `src/plantuml/invocations.ts` (pure module)

**`aliasDefinitions(text, fenceStartLine)`** — new export, ~15 lines. Reuses the
existing `PROC_OPEN_REG` and `saltInvocationLines`'s second pass (which already
builds `procRanges`). Produces `Map<alias, definitionLine>` for one fence,
first-wins on duplicate.

**`invocationReferences(text, fenceStart, fenceEnd, alias)`** — new export, ~15
lines. Scans the fence for *every* `SALT(alias)` occurrence (not deduplicated
like `saltInvocationLines`). Used by the `ReferenceProvider`. Skips lines
starting with `!` or `'` (PlantUML directives/comments) to avoid false
positives.

Both stay pure (no `vscode` import) — unit-testable in plain Node.

### 2. Providers — `src/completions/definitions.ts` (vscode boundary)

**`DefinitionProvider`** — the primary feature. Mirrors `provider.ts`'s shape:

1. `fenceAt(document.getText(), position.line)` → `undefined` outside puml.
2. Word at cursor via `/\w/` boundary scan (covers `enroll_uploading_1`).
3. `aliasDefinitions(document.getText(), fence.startLine).get(alias)`.
4. When the word starts with `_` and direct lookup misses, strip the leading
   `_` and retry — this is what makes VS Code's `editor.action.revealDefinition`
   see "1 result at cursor" and trigger references.

**`ReferenceProvider`** — the reverse direction. Same fence + word gate:

1. If word starts with `_`, strip it (`_enroll_uploading_1` → `enroll_uploading_1`).
2. Verify the alias exists in `aliasDefinitions`.
3. `invocationReferences(text, fence.start, fence.end, alias)` → all `SALT(alias)`
   line numbers.
4. Return locations, one per invocation with the exact column of the
   `SALT(alias)` token.
5. Include the definition line as the first entry, so "Find All References"
   always shows the definition plus all call sites.

Both registered from `registerDefinitions(context)` called in `activate()`.

### 3. Activation — `src/extension.ts`

```ts
import { registerDefinitions } from './completions/definitions';

// in activate():
registerDefinitions(context);
```

No new `activationEvents` entry needed.

## Files

- **new** `src/completions/definitions.ts` (~95 lines) — vscode boundary:
  `DefinitionProvider` + `ReferenceProvider` + `registerDefinitions`.
- **edit** `src/plantuml/invocations.ts` (~ +30 lines) — new exports
  `aliasDefinitions()` and `invocationReferences()`; no change to existing
  functions.
- **edit** `src/extension.ts` (+2 lines) — import + register.
- **new** `tests/plantuml_definition_check.cjs` (~230 lines) — pure-logic checks
  for both `aliasDefinitions` (5 sections + 10 cases) and `invocationReferences`
  (1 section + 5 cases).
- **doc** `docs/important/architecture.md` — deep-dive bullet + limitations.
- **doc** `docs/important/how-to-test.md` — new section §3k, Quick Reference row.
- **doc** `docs/important/features.md` — feature bullet.
- **doc** `docs/plans/...` — this plan document.

## How the "definition → references" fallthrough works (VS Code core)

In `_refs/vscode/src/vs/editor/contrib/gotoSymbol/browser/goToCommands.ts:140`:

```typescript
if (referenceCount === 1 && altAction) {
    // Only result is where cursor already is → run alternative command
    // Default: 'editor.action.goToReferences'
}
```

When the DefinitionProvider returns a single location whose range contains the
cursor position, VS Code does not navigate there (it would be a no-op). Instead
it fires the **alternative command** — default `editor.action.goToReferences`,
configurable via `editor.gotoLocation.alternativeDefinitionCommand`.

So the three-line `_`-prefix check in our DefinitionProvider:
```ts
if (defLine === undefined && w.word.startsWith('_')) {
    defLine = defs.get(w.word.slice(1));
}
```
is all the glue needed. No custom commands, no keybinding overrides, no settings.

## Trade-offs accepted

- **Bare alias also "defines".** The provider does not require the cursor to
  be inside `SALT(...)`. `enroll_uploading_1` typed anywhere in a puml fence
  (e.g. a comment, the procedure's own `!endprocedure` return value) returns
  the definition. This is harmless (matches the first definition, same
  destination) and keeps the provider a few lines shorter.
- **Shift+F12 on a procedure definition shows references.** Acceptable UX;
  the ReferenceProvider naturally handles the `_`→alias transformation.

## How to test

### Pure-logic check — `tests/plantuml_definition_check.cjs`

```sh
npm run compile
node tests/plantuml_definition_check.cjs
```

| Section | Cases |
| --- | --- |
| `aliasDefinitions` basic | 3 cases: returns all aliases, empty map for no-proc fence, empty map for non-existent fence line |
| per-fence isolation | 2 cases: fence A returns only A's aliases, fence B returns only B's |
| duplicate alias, first wins | 1 case: two `!procedure _dup()` → first definition line |
| underscore stripping | 2 cases: `form_empty` not `_form_empty`; `__highlight` → `_highlight` |
| tildes and mixed fence types | 1 case: `~~~puml` also works |
| invocation references | 5 cases: repeated alias finds all, non-repeated alias, note/comments skipped, unknown → empty, non-puml → empty |

### Manual dev-host check

```sh
tools/launch-devhost.sh --file "$PWD/tests/samples/enroll-flow.puml.md"
```

1. **Click on `enroll_uploading_1` inside `SALT(enroll_uploading_1)`** → Jumps to
   `!procedure _enroll_uploading_1()` (line 213).
2. **Click on `_enroll_extracting_1` in `!procedure _enroll_extracting_1()`** →
   Shows all `SALT(enroll_extracting_1)` invocations (the built-in VS Code
   "result at cursor → alternative command" mechanism fires).
3. **Shift+F12 on `_enroll_extracting_1`** → Same references.
4. **F12 on a non-alias word like `note` or `end note`** → "No definition found".

### Workbench CDP probe (optional)

For a scriptable end-to-end assertion:

```sh
# evaluate via the workbench CDP target
node tests/cdp_eval.cjs <port> page "..." "
  const loc = await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider',
    vscode.Uri.file('$PWD/tests/samples/enroll-flow.puml.md'),
    new vscode.Position(466, 20)  // inside SALT(enroll_uploading_1)
  );
  console.log(loc[0].range.start.line); // 212 (0-based)
"
```

## Verification summary

- `npm run compile` (strict TS) — pass.
- `node tests/plantuml_definition_check.cjs` — **15 checks** across 6 sections,
  all green.
- `node tests/plantuml_check.cjs`, `tests/plantuml_completion_check.cjs`,
  `tests/plantuml_inline_check.cjs`, `tests/mermaid_check.cjs`,
  `tests/plantuml_note_highlight_check.cjs` — all still green (the new exports
  are additive; no webview / fence-rewrite change).
- Manual: F12 on `enroll_uploading_1` → cursor at line 213. Alt+Click on
  `_enroll_extracting_1` → shows references. Shift+F12 → shows references.
- The "definition → references" fallthrough relies on VS Code's own
  `goToCommands.ts:140` — no custom keybinding, no package.json change, no
  settings.

## Known limitations

- **Same-fence only.** An alias defined via `!include` (in another file) is
  not found — the provider only scans the current fence.
- **Only procedure aliases.** Targets of class/actor/participant names, skin
  definitions etc. are not resolved.
- **Resolution is text-based, not semantic.** `enroll_uploading_1` in a
  comment inside the puml fence will also jump to its definition. The
  boundary is the cursor being inside a puml fence and the word matching an
  alias declared in that fence.
- **ReferenceProvider returns all invocations, no grouping.** Repeated
  `SALT(x)` calls on the same alias are all listed separately (Shift+F12 shows
  a flat list). This matches the expected "find all references" UX.

---

# Part 2: Additional LSP features for PlantUML procedure aliases

**Date:** 2026-08-21
**Status:** PLAN — review before implementation
**Files added:** (none yet)
**Files edited:** `src/completions/definitions.ts`, `src/plantuml/invocations.ts`,
`src/extension.ts`, `tests/plantuml_definition_check.cjs`

## Goal

Extend the existing alias-aware LSP providers inside puml fences with five
more language features that require no parser, no cross-file resolution, and
no `package.json` changes — all self-gated by `fenceAt()` on `{ language: 'markdown' }`:

| # | Provider | Trigger | Effect |
| --- | --- | --- | --- |
| 1 | **Hover** | Hover over `SALT(alias)` or `_alias` | Tooltip shows the `!procedure _alias()` signature + reference count |
| 2 | **Rename** | F2 on `SALT(alias)` or `_alias` | Renames alias in all `SALT(...)` calls + the `!procedure` definition in the same fence |
| 3 | **Document Highlights** | Click on `SALT(alias)` or `_alias` | Highlights all occurrences of that alias in the fence |
| 4 | **Code Lens** | Editor gutter above each `!procedure` | Shows "N references" link |
| 5 | **Folding Range** | Gutter fold controls | Folds `!procedure … !endprocedure` blocks |

All five reuse the same core machinery: `aliasDefinitions()` and a new shared
`aliasOccurrences()` function in the pure module. None need a PlantUML parser;
all are text-based, same-fence only.

## Design

### 0. Shared pure helper — `src/plantuml/invocations.ts`

**`aliasOccurrences(text, fenceStart, fenceEnd, alias)`** — new export, ~25
lines. Returns every position where the alias (bare) or `_alias` (in
`!procedure _alias()`) appears in the fence, with enough detail for highlights,
rename, and code lens:

```ts
interface AliasOccurrence {
  line: number;         // 0-based absolute line
  startCol: number;     // 0-based column of the alias word start
  endCol: number;       // 0-based column of the alias word end
  kind: 'definition' | 'invocation' | 'other';
}
```

- **definition**: the line matching `!procedure _<alias>()` — the `_alias` word
  (after the `_` prefix is stripped).
- **invocation**: a line containing `SALT(<alias>)` — the bare alias inside
  `SALT(...)`.
- **other**: bare alias word on any other line (comments, arrows, etc.).

Lines starting with `'` (PlantUML comments) or `!` (directives other than the
definition line itself) are skipped for `invocation` and `other` kinds.

This function is the single source of truth for all five providers below,
replacing the ad-hoc `invocationReferences()` with a richer return type.
(`invocationReferences()` can be kept as a thin wrapper that calls
`aliasOccurrences().filter(kind === 'invocation').map(loc => loc.line)` for
backward compatibility.)

### 1. Hover Provider — `src/completions/definitions.ts` (~25 lines)

**Flow:**
1. `fenceAt()` — return `undefined` outside puml fences.
2. `wordAt()` — extract the word under cursor.
3. Resolve alias via `aliasDefinitions()` (with `_`-prefix fallback).
4. If found, build a `Hover` with:
   - A fenced code block of the `!procedure _<alias>()` signature line.
   - The invocation count from `aliasOccurrences().filter(kind === 'invocation')`.
   - The definition line number.

**Example tooltip:**
```
```plantuml
!procedure _enroll_uploading_1()
```
**3 references** · line 213
```

Registration: add `hoverProvider` to `registerDefinitions()`:
```ts
vscode.languages.registerHoverProvider({ language: 'markdown' }, hoverProvider);
```

### 2. Rename Provider — `src/completions/definitions.ts` (~50 lines)

Two callbacks:

**`prepareRename(document, position)`**:
1. `fenceAt()` + `wordAt()`.
2. Resolve alias (with `_`-prefix fallback).
3. If found, return `{ range: wordRange, placeholder: alias }`.
4. If not found, return `undefined` (VS Code shows "No definition found").

**`provideRenameEdits(document, position, newName)`**:
1. Same word + alias resolution.
2. `aliasOccurrences(text, fence.start, fence.end, alias)` → all positions.
3. Build a `WorkspaceEdit` with one `TextEdit` per occurrence (replace the
   alias word at `startCol..endCol` with `newName`).
4. For definition lines (where the word is `_alias`), **keep the `_` prefix**
   and only replace the alias portion: `_alias` → `_newName`.

**Edge case — substring collision:** A rename of `foo` must not match
`foobar`. Since `aliasOccurrences` matches the exact alias word using
`/\w/` boundaries, `foobar` is not returned. The `SALT(foo)` match is also
exact — `SALT(foobar)` has the wrong parentheses boundaries. Verified in
tests.

**Edge case — non-alias word in fence:** E.g. cursor on `end note` in a puml
fence. `prepareRename` returns `undefined` — no rename offered.

**Validation — `newName`:** Must be a valid PlantUML identifier (matches
`/^\w+$/`). If not, return a rejection (throw or return `undefined`).

### 3. Document Highlights Provider — `src/completions/definitions.ts` (~20 lines)

**Flow:**
1. `fenceAt()` + `wordAt()`.
2. Resolve alias (with `_`-prefix fallback).
3. `aliasOccurrences()` → all positions.
4. Return `DocumentHighlight[]` with:
   - Definition → `DocumentHighlightKind.Write` (distinct color).
   - Invocations → `DocumentHighlightKind.Read`.
   - Other occurrences → `DocumentHighlightKind.Text`.

```ts
vscode.languages.registerDocumentHighlightProvider({ language: 'markdown' }, highlightProvider);
```

### 4. Code Lens Provider — `src/completions/definitions.ts` (~30 lines)

**Flow:**
1. Scan the entire document for `!procedure _<alias>()` lines inside puml
   fences (reuses `definitions.ts` by calling `aliasDefinitions()` per fence).
2. For each procedure, count invocations via `aliasOccurrences()
   .filter(kind === 'invocation').length`.
3. Return a `CodeLens` per definition, positioned at the `!procedure` line,
   with:
   - **Title:** `"N references"` or `"0 references"`.
   - **Command:** `editor.action.showReferences` (opens the references peek
     view at that position).

```ts
vscode.languages.registerCodeLensProvider({ language: 'markdown' }, codeLensProvider);
```

**Performance note:** CodeLens providers are called often (on every idle).
If the document is large with many fences, the per-fence scan could add up.
Mitigation: cache the scan result per document version and invalidate on
`onDidChangeTextDocument`. For v1, skip the cache — the scan is text-based
and fast (regex over fence-sized strings).

### 5. Folding Range Provider — `src/completions/definitions.ts` (~20 lines)

**Flow:**
1. Scan the document for puml fence boundaries via the existing `fenceAt()`
   loop (or add a `fencesInDocument()` helper).
2. Inside each fence, match `/^!procedure\b/` and `/^!endprocedure\b/` lines.
3. For each matched pair, emit a `FoldingRange` from the `!procedure` line to
   the `!endprocedure` line.

```ts
vscode.languages.registerFoldingRangeProvider({ language: 'markdown' }, foldingProvider);
```

**Nesting:** `!procedure` blocks do not nest in PlantUML SALT, so no stack
tracking is needed. If a `!procedure` is unmatched, skip it.

## File changes

### `src/plantuml/invocations.ts` (~ +40 lines)

New exports:
- `aliasOccurrences(text, fenceStart, fenceEnd, alias): AliasOccurrence[]`
  — the shared workhorse for all five providers.
- `AliasOccurrence` interface (exported).

`invocationReferences()` refactored to a thin wrapper:
```ts
export function invocationReferences(…): number[] {
  return aliasOccurrences(…)
    .filter(o => o.kind === 'invocation')
    .map(o => o.line);
}
```

### `src/completions/definitions.ts` (~ +140 lines)

Five new provider objects + their registrations in `registerDefinitions()`.

### `src/extension.ts` — no change needed

`registerDefinitions(context)` already called; new providers registered inside it.

## Pure-logic test additions (`tests/plantuml_definition_check.cjs`)

Update existing file — append new sections (or create a separate
`tests/plantuml_lsp_check.cjs` if it gets too large). New sections:

| Section | Cases |
| --- | --- |
| `aliasOccurrences` basic | 3 cases: returns definition + invocations for a fence; returns empty for unknown alias; returns empty outside fence |
| occurrence kinds | 3 cases: definition kind vs invocation kind vs other kind |
| substring safety | 2 cases: `SALT(foo)` does not match `SALT(foobar)`; `_foo` definition does not match `_foobar` |
| rename prepare | 3 cases: valid alias returns range; `_`-prefixed word returns range; non-alias returns undefined |
| rename edits | 2 cases: renames SALT() calls + definition; keeps `_` prefix on definition line |
| highlights | 2 cases: cursor on alias returns all occurrences; cursor on non-alias returns empty |
| code lens | 2 cases: one procedure shows "N references"; zero-procedure fence shows no lens |
| folding ranges | 3 cases: basic `!procedure`/`!endprocedure` pair; unmatched opening; nested NBSP / no nesting |

**Total new checks:** ~20, all running with `node tests/plantuml_definition_check.cjs`.

## Dev-host manual checks

```sh
tools/launch-devhost.sh --file "$PWD/tests/samples/enroll-flow.puml.md"
```

1. **Hover** over `SALT(enroll_uploading_1)` → tooltip shows
   `!procedure _enroll_uploading_1()` + "2 references" + line number.
2. **Hover** over `_enroll_uploading_1` on procedure line → same tooltip.
3. **F2** on `enroll_uploading_1` → rename offered; type `foo` → all
   `SALT(foo)` + `!procedure _foo()` updated; `SALT(enroll_extracting_1)` unaffected.
4. **F2** on `end note` → no rename offered.
5. **Click** on `SALT(enroll_uploading_1)` → all occurrences of
   `enroll_uploading_1` and `_enroll_uploading_1` highlighted in fence.
6. **Code Lens** above `!procedure _enroll_uploading_1()` shows "2 references".
7. **Fold** the `!procedure _enroll_uploading_1() … !endprocedure` block.

## Workbench CDP probes (optional)

```sh
# Hover probe
cdp_eval workbench "...
  const h = await vscode.commands.executeCommand(
    'vscode.executeHoverProvider',
    vscode.Uri.file('$PWD/tests/samples/enroll-flow.puml.md'),
    new vscode.Position(466, 20)
  );
  console.log(h[0].contents[0].value);
"

# Rename probe
cdp_eval workbench "...
  const edits = await vscode.commands.executeCommand(
    'vscode.executeDocumentRenameProvider',
    vscode.Uri.file('$PWD/tests/samples/enroll-flow.puml.md'),
    new vscode.Position(466, 20),
    'foo'
  );
  console.log(edits.edits.length);
"
```

## Trade-offs and limitations

- **All five are same-fence only.** Cross-file aliases via `!include` are not
  resolved — same constraint as the Definition/Reference providers.
- **Text-based, not semantic.** A bare alias word in a PlantUML comment
  counts toward highlights and the rename scope. This is consistent with the
  existing providers and keeps the code simple.
- **Rename has no undo scoping.** The rename edits are text replacements at
  specific ranges; no refactoring preview / cancellation beyond VS Code's
  native undo stack.
- **CodeLens scans the full document on every idle tick.** For documents
  with many puml fences (>50), a single-pass scan returning all lenses at once
  is fast, but if profiling shows jank, a per-document-version cache can be
  added later.
- **Folding is flat.** `!procedure` blocks at the same level fold independently;
  nested procedures (not valid in PlantUML SALT) are not handled.
- **Hover shows the raw definition line**, not a rendered signature. The
  definition line is already the full `!procedure _<alias>()` — no parameters
  to display. If the procedure has a `{% %}` body comment (like a docstring),
  we could include the first line of it in the future.
- **No cross-provider caching.** Each provider re-scans the fence on every
  invocation. For a single fence with ~20 procedures, each scan is <1 ms —
  not worth caching in v1.
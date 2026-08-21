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
# Bug: `note on link` keyword highlighting lost after first `end note` — affects all subsequent lines

**Status:** FIXED (2026-08-21)
**Severity:** medium (all PlantUML keyword highlighting broke after the first
multi-line note block in markdown fences — but only when Volar was enabled)

## TL;DR

Volar's `vue.interpolations` injection grammar matches `{{ … }}` everywhere in
markdown. PlantUML SALT mockups use `{{salt … }}`, so Volar was swallowing the
SALT body inside `plantuml` fences and corrupting VS Code's tokenization state
for the rest of the fence (every `note on link` / `end note` / `-->` line after
the first multi-line note collapsed to a single flat token span).

The fix is a one-line `contentName` change that puts the fence body inside a
`comment.block.*` scope, which Volar's own `injectionSelector` already excludes:

```diff
--- a/syntaxes/codeblock.json
+++ b/syntaxes/codeblock.json
@@                 {
                     "begin": "(^|\\G)(\\s*)(.*)",
                     "while": "(^|\\G)(?!\\s*([`~]{3,})\\s*$)",
-                    "contentName": "meta.embedded.block.plantuml",
+                    "contentName": "meta.embedded.block.plantuml comment.block.plantuml",
```

## Summary of the bug

After the first `note on link ... end note` block inside a ` ```plantuml `
markdown fence, ALL subsequent lines lost PlantUML keyword highlighting. The
first `note on link` (and everything before it) got correct keyword scopes, but
everything after `end note` became flat (no keyword/variable distinction).

The whole story turned out to be **three layers deep**:

1. The original report claimed it affected the isolated dev host (9337) AND the
   real window (9333) equally, and went hunting inside the grammar repo. That
   was wrong on both counts.
2. The bug was actually triggered only by a user extension — specifically
   `vue.volar` — but pinning that down took diligence because the broken
   pattern only showed up AFTER the first `end note`.
3. The eventual fix is not in the repo's own patterns at all; it leans on the
   scope selector of the offending injection grammar.

## Symptoms (broken window, before the fix)

Captured live via CDP `Runtime.evaluate` reading `.view-line > span.mtk*`
classes from the editor DOM.

```
Line 320 — note on link (BEFORE first end note) — correct:
  [note:mtk5 mtkb] [ ] [on link:mtk5 mtkb]

Line 329 — sample_row_empty --> SALT(sample_recording) (AFTER end note) — flat:
  [sample_row_empty --:mtk9] [>:mtk9 unexpected-closing-bracket]
  [ SALT:mtk9] [(:mtk9 bracket-highlighting-0]
  [sample_recording:mtk9] [):mtk9 bracket-highlighting-0]

Line 330 — note on link (AFTER first end note) — flat:
  [note on link:mtk9]
```

The `>` of `-->` being flagged `unexpected-closing-bracket` was the smoking
gun: the tokenization engine was discarding bracket state right after the first
multi-line note.

## Trial 1 — wrong root cause: "old grammar shipped to the install dir"

The installed extension's `syntaxes/codeblock.json` differed from the working
tree (it lacked the nested `begin/while` wrapper). Plausible-sounding:

- 9334 dev host (loaded from working tree via `--extensionDevelopmentPath`) → WORKED
- 9333 real window (loaded from installed extension dir) → BROKEN

So we copied the working-tree `codeblock.json` over the installed one and
reloaded the window. **Same flatness.** Closed & reopened the tab (per
`how-to-test.md` §3f: "open editors cache tokens … Reload Window alone is not
enough"). **Same flatness.** Diffed `plantuml.tmLanguage.json`: identical
between install and working tree.

→ The grammar in the repo is correct standalone. The trigger is environmental.

## Trial 2 — bisecting the user extension

Brought up a control pair with the same working tree loaded both ways:

| Host | Setup | Result |
| --- | --- | --- |
| 9334 | `--disable-extensions` (dev extension + built-ins only) | CORRECT |
| 9334 | `--with-extensions` + `--disable-extension vue.volar` | CORRECT |
| 9334 | `--with-extensions` (Volar on) | BROKEN |
| 9333 | real window (all user extensions incl. Volar) | BROKEN |
| offline `vscode-textmate@9.3.2` with injection wrapper | pure grammar | CORRECT |

→ Pin pointed to `vue.volar` specifically.

## Trial 3 — pinning the offending pattern in Volar

Volar ships an injection grammar `vue.interpolations`
(`syntaxes/vue-interpolations.json`) with `injectionSelector:
"L:text.html.markdown -comment.block"`. It includes
`text.html.vue#vue-interpolations`, which is the classic Vue `{{ }}` block:

```jsonc
// vue.volar/syntaxes/vue.tmLanguage.json
"vue-interpolations": {
  "patterns": [ {
    "begin": "(\\{\\{)",
    "end":   "(\\}\\})",
    "name":  "expression.embedded.vue",
    "patterns": [ { "begin": "\\G", "end": "(?=\\}\\})", "name": "source.ts.embedded.html.vue", ... } ]
  } ]
}
```

SALT mockups are written as `{{salt … }}` — the EXACT `{{ }}` syntax Vue uses.
So inside a `plantuml` fence, Volar opens a `source.ts.embedded.html.vue`
scope at every `{{salt`, "ends" it at the next `}}`, and the residual state
from that interpolation corrupts the rest of the fence.

Confirmed by running `Developer: Inspect Editor Tokens and Scopes` while
parked on `{+` (inside a SALT body). Scope stack:

```
source.ts.embedded.html.vue           ← Volar owns this
expression.embedded.vue               ← Volar pushed this at {{salt
meta.object-literal.key.ts
meta.object.member.ts
meta.objectliteral.ts
source.ts.embedded.html.vue
expression.embedded.vue
diagram.source.wsd                    ← our plantuml scope (underneath)
meta.embedded.block.plantuml
markup.fenced_code.block.markdown
text.html.markdown
```

## Trial 4 — wrong fix: "win the `{{salt` match on length"

First tried a `#SaltBlock` begin/end pattern in `plantuml.yaml-tmLanguage`:

```yaml
begin: (?i)\{\{(salt|qa|tree|fish|indentation)\b
end:   (?i)\}\}
```

Hypothesis: oniguruma's "longest match wins" would pick this (6 chars:
`{{salt`) over Volar's `\{\{` (2 chars). Built the grammar, reloaded, ran
`tests/plantuml_note_highlight_check.cjs 9334`.

→ **FAIL.** Instructor still showed `expression.embedded.vue` on top of our
`diagram.source.wsd`. Injection patterns take precedence over the base grammar
at the same scan position; length-matching did not apply across the
base/injection boundary.

## Trial 5 — THE FIX: sit under `comment.block.*` so Volar excludes us

Re-read Volar's `injectionSelector`:
`"L:text.html.markdown -comment.block"`. The `-comment.block` is a
scope-selector exclusion: it skips wherever `comment.block` is anywhere in the
scope stack. We can opt into that exclusion by adding a `comment.block.*`
scope as our fence's `contentName`:

```diff
--- a/syntaxes/codeblock.json
+++ b/syntaxes/codeblock.json
@@                 {
                     "begin": "(^|\\G)(\\s*)(.*)",
                     "while": "(^|\\G)(?!\\s*([`~]{3,})\\s*$)",
-                    "contentName": "meta.embedded.block.plantuml",
+                    "contentName": "meta.embedded.block.plantuml comment.block.plantuml",
                     "patterns": [ { "include": "source.wsd" } ]
                 }
```

Both scope names are kept: `meta.embedded.block.plantuml` for tooling that
looks for it, `comment.block.plantuml` to make Volar (and any other well-behaved
injection with a `-comment.block` exclusion) correctly skip the fence contents.

Reloaded the dev host, closed & reopened the file, re-ran the test.

→ **PASS.** Instructor now shows clean scope stacks with NO `vue.interpolations`
frame on top.

## Cosmetic follow-up — `#SaltBlock` repository

Without an explicit call-out, the catch-all in `multi-line note of over`'s body
(`meta.comment.multline.noteof.source.wsd .+?`) flattens the SALT inner text to
one token span. Added a `#SaltBlock` repository to `plantuml.yaml-tmLanguage`
that scopes the braces/labels of `{{salt … }}`, and referenced it from `#General`
and from the `multi-line note of over` body.

This is purely cosmetic — the actual bug fix is the `contentName` change above.
The two changes are independent; the bug fix would hold even without this one.

## Verification matrix (after the fix)

Captured live via CDP on the 9334 dev host (`--with-extensions`,
`vue.volar` enabled; the previously-broken case) and on the 9333 real window
(all user extensions incl. Volar + the Eink 60Hz theme).

| Line | Tokens (Eink 60Hz theme classes) | Status |
| --- | --- | --- |
| `note on link` | `note`=mtk5 mtkb, ` `=mtk4 mtki, `on link`=mtk5 mtkb | ✓ split |
| `end note` | the whole keyword=mtk5 mtkb | ✓ keyword |
| `--> SALT(arg)` | `SALT`/`arg`=mtk9 mtkb, `-->`=mtk5 mtkb, operators=mtk4 mtki | ✓ split |
| All four `note on link … end note` blocks | consistent across every block | ✓ |

- `node tests/plantuml_note_highlight_check.cjs 9334` now **PASS**es against
  both `--with-extensions` (Volar on) and isolated launches. Before the fix it
  FAILed on Volar-on with 4 flat lines + `unexpected-closing-bracket` flags.
- Pure-logic checks remain green: `plantuml_check.cjs`,
  `plantuml_completion_check.cjs`.
- Offline `vscode-textmate` tokenization probe (`/tmp/tok/check_fix.cjs`)
  still produces correct scope stacks; the stacks now additionally carry
  `comment.block.plantuml` between `meta.embedded.block.plantuml` and
  `diagram.source.wsd`.

## Files changed

| File | Change |
| --- | --- |
| `syntaxes/codeblock.json` | `contentName` gets ` comment.block.plantuml` appended — **the actual fix**. |
| `syntaxes/plantuml.yaml-tmLanguage` | New `#SaltBlock` repository (cosmetic, scopes `{{salt … }}` braces and labels); referenced from `#General` and the `multi-line note of over` body. |
| `syntaxes/plantuml.tmLanguage.json` | Rebuilt from YAML via `npm run build:syntax`. |
| `tests/plantuml_note_highlight_check.cjs` | New CDP regression test (added during diagnosis; useful for catching future Volar-vs-plantuml regressions). |
| `docs/important/how-to-test.md` | New row in the quick-reference table for the new test; a note in §3f explaining the Volar/SALT interaction. |

## Reproduction (for the historical record)

```bash
# 1) Confirm the bug WOULD reproduce (Volar on, before-fix codeblock.json):
tools/launch-devhost.sh --port 9334 --with-extensions \
  --profile "$PWD/exp/devhost-withext" \
  --file "$PWD/tests/samples/enroll-flow.puml.md"
node tests/plantuml_note_highlight_check.cjs 9334   # FAIL on pre-fix build

# 2) Confirm Volar was the trigger (Volar off):
tools/kill-devhost.sh 9334
setsid nohup /usr/share/code/code \
  --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost-withext" \
  --remote-debugging-port=9334 --with-extensions --disable-extension vue.volar \
  --new-window "$PWD/tests/samples/enroll-flow.puml.md" \
  > exp/devhost-launch.log 2>&1 < /dev/null &
node tests/plantuml_note_highlight_check.cjs 9334   # PASS even without the fix
```

## Lessons

- **`-comment.block` in `injectionSelector` is a real lever** you can pull from
  the receiving side. Any markdown fence whose language you want to protect from
  a broad injection grammar can opt into the exclusion by adding
  `comment.block.<lang>` to its `contentName`.
- **`Developer: Inspect Editor Tokens and Scopes` is the fastest way to confirm
  scope-stack interference**. Color classes (`mtk*`) only tell you the *paint*;
  the full scope list tells you *who owns it* (Volar's
  `source.ts.embedded.html.vue` sitting ABOVE our `diagram.source.wsd` was the
  giveaway).
- **Don't trust the bug report's "affects both hosts" claim blindly.** A fresh
  `--disable-extensions` dev host is the cheapest control; in this bug it
  revealed that the repo's grammar was fine and the trigger was an extension
  that didn't even claim plantuml support.

## Upstream

Volar's `vue.interpolations` injection has `injectionSelector:
"L:text.html.markdown -comment.block"` which does NOT exclude markdown fenced
code blocks in general (`meta.embedded.block.*` is not `comment.block`). Code
fences are logically opaque to other injections; matching `{{ }}` inside them
is arguably a bug worth filing upstream. Our `comment.block.plantuml` workaround
sidesteps it regardless of whether Volar changes their selector.

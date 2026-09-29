# Integration-test fixture paths: stop hardcoding the code-server mount

**Date:** 2026-09-29
**Status:** DONE (typecheck clean; resolver smoke-tested from both the
`_submodules/` checkout and the canonical mount)
**Files edited:** `tests/integration/test_utils.ts`,
`tests/integration/{custom_styles,editor_preview,link_nav,pin_lifecycle,plantuml_intellisense,plantuml_render_check,preview_misc}_ix.ts`,
`docs/important/how-to-test.md`

## Context

This is a follow-up review of the test-infrastructure work merged in
`4664932` (*Add CDP integration tests for 12 feature coverage gaps (B1–B12)*),
`832c5f0` (*Rework integration tests to use REST control API*) and `e1b72be`
(*Clean up integration tests so they leave no unsaved buffers*). That range
added the REST control helper (`tests/integration/rest.ts`), the shared suite
runner (`test_utils.ts`), 10 `*_ix.ts` suites, and a large `how-to-test.md`
expansion — no `src/` changes.

Reading the aggregate diff (`4664932^..HEAD`, 16 files / +1665) surfaced two
defects worth fixing:

1. **A lost section heading in `how-to-test.md`.** The hunk that inserted
   *Running multiple integration tests against code-server* replaced the
   existing `### Mermaid extension highlight override (code-server)` line, so
   the mermaid paragraph dangled under *PlantUML server must be reachable from
   the container* with no heading of its own.
2. **Hardcoded fixture paths in the new suites.** Seven files declared
   `const WS = '/home/lamnt45/git/vscode-hacker-markdown/tests/samples…'`.
   That path only exists on the pp/code-server machine; on a plain checkout
   (the meta repo's `_submodules/vscode-hacker-markdown`, or a dev host run
   from anywhere else) every `restOpenFile()` would point at a non-existent
   file.

## Fix 1 — restore the heading

Re-inserted `### Mermaid extension highlight override (code-server)` before
the `mermaidchart.vscode-mermaid-chart` paragraph. Purely a docs fix; no
behavior change.

## Fix 2 — resolve fixture paths instead of hardcoding them

Added a resolver to `tests/integration/test_utils.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const EXT_ROOT: string = (() => {
	const override = process.env.HMK_EXT_ROOT;
	if (override) return override;
	const canonical = '/home/lamnt45/git/vscode-hacker-markdown';
	if (existsSync(join(canonical, 'tests', 'samples'))) return canonical;
	return join(import.meta.dirname, '..', '..');
})();

export const SAMPLES   = join(EXT_ROOT, 'tests', 'samples');
export const WORKSPACE = join(SAMPLES, 'workspace');
```

Resolution order:

1. **`HMK_EXT_ROOT`** env override — used verbatim, no probing. This is the
   escape hatch for split setups where the extension host does not share a
   filesystem with the test runner (e.g. a remote dev host, or code-server in
   a container whose mount path differs from the runner's checkout).
2. **Canonical code-server mount** `/home/lamnt45/git/vscode-hacker-markdown`,
   but only when it actually exists locally (Option A).
3. **Derived from the test file** (`import.meta.dirname` is
   `tests/integration`, so `../..` is the repo root) — Option B dev host, or
   this `_submodules/` checkout.

The suites that open fixtures now import the constant and alias it to their
existing `WS` name, so no call sites changed:

| Suite | Import | `WS` |
| --- | --- | --- |
| `custom_styles_ix.ts` | `WORKSPACE as WS` | `…/tests/samples/workspace` |
| `editor_preview_ix.ts` | `WORKSPACE as WS` | `…/tests/samples/workspace` |
| `link_nav_ix.ts` | `WORKSPACE as WS` | `…/tests/samples/workspace` |
| `pin_lifecycle_ix.ts` | `WORKSPACE as WS` | `…/tests/samples/workspace` |
| `plantuml_render_check.ts` | `WORKSPACE as WS` | `…/tests/samples/workspace` |
| `plantuml_intellisense_ix.ts` | `SAMPLES as WS` | `…/tests/samples` |
| `preview_misc_ix.ts` | `SAMPLES as WS` | `…/tests/samples` |

Documented the new knob in `docs/important/how-to-test.md` (intro, after the
`cdp.ts` description): fixture paths are resolved, and `HMK_EXT_ROOT` should be
set when runner and extension host don't share a filesystem.

`tests/integration/zoom-reset.spec.ts` (Playwright, `?folder=…` URL) was left
untouched — it is pre-existing and serves a different pipeline.

## Why `import.meta.dirname` (not `__dirname` / `import.meta.dir`)

- The suite runs under **bun** (`"type": "commonjs"`, `.ts` sources); both
  `import.meta.dirname` and bun's `import.meta.dir` resolve at runtime (verified).
- `import.meta.dirname` is the **Node standard** form and is declared by the
  installed `@types/node@26`, so `npm run typecheck:tests` stays clean without
  adding `bun-types`. `import.meta.dir` would need bun's ambient types.

## Verification

```sh
npm run typecheck:tests   # clean (tsconfig.tests.json covers units + integration)
```

Runtime probe from this checkout:

```
EXT_ROOT  /home/lamnt45/git/vscode-hacker-meta/_submodules/vscode-hacker-markdown
SAMPLES   …/tests/samples
WORKSPACE …/tests/samples/workspace
```

With `HMK_EXT_ROOT=/home/lamnt45/git/vscode-hacker-markdown`, resolution flips
to the canonical mount (the code-server case). Every referenced fixture exists
(`tests/samples/custom.css`, `tests/samples/enroll-flow.puml.md`,
`tests/samples/workspace/{test,sub,plantuml-render}.md`).

## Diff summary (working tree)

```
docs/important/how-to-test.md                 | 12 ++++++++++-
tests/integration/custom_styles_ix.ts         |  4 +---
tests/integration/editor_preview_ix.ts        |  4 +---
tests/integration/link_nav_ix.ts              |  4 +---
tests/integration/pin_lifecycle_ix.ts         |  4 +---
tests/integration/plantuml_intellisense_ix.ts |  3 +--
tests/integration/plantuml_render_check.ts    |  3 +--
tests/integration/preview_misc_ix.ts          |  4 +---
tests/integration/test_utils.ts               | 31 +++++++++++++++++++++++++++
9 files changed, 49 insertions(+), 20 deletions(-)
```

## Lessons

- **Review the diff, not just the feature.** Both defects were introduced by
  otherwise-good commits (a heading clobbered by a section insert; a path that
  is correct on exactly one machine). Neither would fail on the pp/code-server
  machine, so only a diff read catches them.
- **Test fixtures are extension-host paths, not runner paths.** Under
  code-server the REST server runs inside the container; the absolute path in
  the test must be the container's view. A resolver with an env override keeps
  the common case automatic and the split case explicit.

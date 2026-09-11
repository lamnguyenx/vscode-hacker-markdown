# Hacker Markdown: CDP debugging & code-server gotchas

**Date:** 2026-09-11
**Status:** DONE
**Context:** Live debugging session where three bugs were fixed and several
code-server-specific architecture traps were uncovered.

## Summary of fixes

| # | Bug | Root cause | Fix |
|---|---|---|---|
| 1 | Code blocks rendered in serif font | `font-family: var(--vscode-editor-font-family, ...)` — CSS `var()` with fallback discards the fallback chain when the variable IS set (to `Consolas Nerd Font`). That font doesn't exist on the code-server host, so the browser defaulted to serif. | Move var to first list item: `font-family: var(...), "SF Mono", ..., monospace` + `!important` + inline `<style>` in `buildHtml()` |
| 2 | Column-width input shrinks the toolbar | `body { max-width: var(--hmk-column-width, 100%); }` constrained the entire `<body>`, including the toolbar inside it. | Move `max-width` + `margin: 0 auto` from `body` to `.markdown-body` |
| 3 | PlantUML diagrams not rendering in code-server | The `mermaidchart.vscode-mermaid-chart` extension overrides `options.highlight` in markdown-it. In code-server, the original highlighter is null, so the fallback returns raw code text. If that text contains `<` (salt mockup syntax like `<b>`), markdown-it returns it without `<pre><code>` wrapper. Our regex required `<pre><code class="language-plantuml">`. Additionally, the mermaid extension wraps content in `<pre style="all:unset;"><div class="mermaid-chart">`, and when our fallback regex captured this wrapper, the PlantUML server received `<div class="mermaid-chart">` as part of the diagram source, returning "Syntax Error". | Added `PUML_UNWRAPPED_REG` fallback regex that matches `<pre>` containing `@start...@end` regardless of inner HTML wrappers. Added `srcMatch` to extract only the `@start...@end` portion before sending to the server. |

## Debugging setup

We used **code-server** (browser-based VS Code) via a **CDP (Chrome DevTools Protocol)** connection on port 9023, not a desktop VS Code dev host. This was the first time this repo's CDP pipeline was exercised on code-server rather than a desktop `code` instance.

### Toolchain

- `chrome-devtools-9023_*` tools in the agent: take_snapshot (accessibility tree), evaluate_script (JS inside the main page), list_console_messages, take_screenshot
- A **vision-capable LLM** (`opencode-go/muse-spark-1.3-contributor`) for reading screenshots when the primary model lacks vision
- Direct `require('fs').writeFileSync('/tmp/hmk-fragment.txt', ...)` in the extension code to dump the rendered fragment to disk (the extension host's `console.log` goes to `remoteexthost.log`, not the browser console)

### Nested iframe structure

code-server's webview architecture has three layers:
1. **Main page** — the workbench UI
2. **Webview iframe** (`iframe.webview`) — the webview container (`pre/index.html`)
3. **Inner content iframe** — the extension's rendered HTML

To reach the preview DOM:
```js
const webviewIframe = document.querySelectorAll('iframe.webview')[0];
const innerDoc = webviewIframe.contentDocument.querySelector('iframe').contentDocument;
const preview = innerDoc.getElementById('preview');
```

The webview iframes can be identified by their `className` containing `"webview"` (detected via `querySelectorAll('iframe.webview')`). The inner iframe's `contentDocument` is accessible because code-server uses same-origin iframes, not OOPIFs (unlike desktop VS Code).

## Key lessons learned

### 1. code-server's extension host is two-tier

code-server runs extensions in TWO separate hosts:
- **Web worker extension host** — for built-in extensions like `vscode.markdown-language-features` (started as a same-origin iframe)
- **Remote extension host** — for user extensions (Node.js process on the server)

This means `markdown.markdownItPlugins: true` does NOT work for user extensions in code-server. VS Code discovers `extendMarkdownIt` by activating the extension's main module and checking its exports. In desktop VS Code, user extensions and the markdown engine share the same extension host process. In code-server, they run in different hosts — the markdown engine loads plugins from the web-worker host, while user extensions export `extendMarkdownIt` into the remote host. The function is never called.

**Implication:** All markdown-it modifications must be done as post-processing of the fragment from `markdown.api.render`, not via `extendMarkdownIt`.

### 2. The mermaid extension's highlight override breaks code fences

The `mermaidchart.vscode-mermaid-chart` (and similar) extensions override `options.highlight` in markdown-it:

```js
e.options.highlight = (t, i, r) => {
  let l = new RegExp("\\b(" + n.languageIds().map(B).join("|") + ")\\b", "i");
  return i && l.test(i) ? `<pre class="mermaid">` : c?.(t, i, r) ?? t
}
```

For non-mermaid fences (like `plantuml`), the fallback is `c?.(t, i, r) ?? t`:
- `c` = the original `options.highlight` (saved before the override)
- In code-server: `c` is `null` (no syntax highlighter in the browser environment)
- `null?.(t, i, r)` → `undefined`
- `undefined ?? t` → `t` (the raw code text)

When `t` contains `<` characters (common in PlantUML salt mockups: `<b>`, `<&microphone>`), markdown-it's fence renderer checks `if (highlighted.indexOf('<') >= 0)` and returns the text as-is WITHOUT the `<pre><code>` wrapper. Our fragment-scanner's regex `<pre><code class="language-plantuml">` then finds nothing.

Furthermore, the mermaid extension's `extendMarkdownIt` also adds a `mermaidContainer` rule that wraps the fence content in `<pre style="all:unset;"><div class="mermaid-chart">`. This wrapper gets captured by our fallback regex and, if sent to the PlantUML server, causes "Syntax Error" because `<div class="mermaid-chart">` is not valid PlantUML.

**Fix:** Two fallback mechanisms in `src/plantuml/fences.ts`:
1. `PUML_UNWRAPPED_REG` — matches `<pre>` containing `@start...@end` regardless of inner HTML structure (catches the mermaid-rewritten format)
2. `srcMatch = content.match(/(@start\w+[\s\S]*?@end\w+)/)` — extracts only the PlantUML source portion, stripping any HTML wrappers before sending to the server

### 3. Version bump is the only reliable cache-bust

code-server's Service Worker caches extension JavaScript. Neither `location.reload()` nor `Navigate` with `ignoreCache: true` bypasses it. The only way to force a fresh extension load:

1. Bump `package.json#version` (e.g., `"2026.9.4"` → `"2026.9.5"`)
2. `npm run compile`
3. `make install`
4. `location.reload()` in the browser

Direct file `cp` to the installed extension directory (`~/.local/share/code-server/extensions/.../`) can work IF the Service Worker cache is invalidated, but it's unreliable. Bumping version is the definitive approach.

### 4. Extension host logs are file-only

`console.log()` from the remote extension host does NOT appear in the browser console. It goes to:
```
~/.local/share/code-server/logs/<timestamp>/exthost<N>/remoteexthost.log
```

Messages prefixed `[Extension Host]` in the browser console are cross-posted by the VS Code service layer and are not the same as raw `console.log()` output. If you need to confirm code execution, write to a temp file:
```js
try { require('fs').writeFileSync('/tmp/hmk-debug.txt', data); } catch {}
```

The log file path can be found by listing:
```bash
ls -td ~/.local/share/code-server/logs/*/exthost*/remoteexthost.log | head -1
```

### 5. CSS var() fallback is not a font fallback chain

```css
font-family: var(--x, "SF Mono", Monaco, ..., monospace);
```

When `--x` IS defined (even if the font doesn't exist on the system), the ENTIRE fallback list inside `var()` is discarded. The property becomes just `font-family: "TheFont"` with zero fallback. To keep the fallback chain:

```css
font-family: var(--x), "SF Mono", Monaco, ..., monospace;
```

This is because CSS `var()` substitution replaces the entire value — the fallback list is only used when the variable is NOT defined (invalid/empty), NOT when the resolved font is missing.

### 6. VLM for webview screenshots

When the primary model lacks vision, delegate screenshot analysis to a vision-capable model:
```bash
opencode run -m "opencode-go/muse-spark-1.3-contributor" \
  "Describe any errors visible in the preview" \
  -f exp/preview.png --variant minimal
```

Use `chrome-devtools-9023_take_screenshot` to capture the page and save to a file, then pass to the VLM.

### 7. Retained webview context traps

The docked webview view uses `retainContextWhenHidden: true`. This means the webview's JavaScript keeps running and its DOM is preserved across workbench reloads. Changes to `build/*.css` files (which are mtime-busted in `cacheBustBuild()`) are NOT picked up until the webview HTML is rebuilt — which only happens when `rebuild()` is called (triggered by `refresh()` only if `hasUserStyles()` returns true, or by a fresh `resolveWebviewView()` call).

To force a fresh webview in code-server:
- Click the "Refresh" button in the preview toolbar (calls `scheduleRender(0)` — re-renders content but does NOT rebuild the HTML page unless `hasUserStyles()` is true)
- Open a new editor-area preview via "Hacker Markdown: Open Preview in Editor" (creates a fresh webview panel with new HTML)
- Or just `location.reload()` to restart the workbench (the docked view is restored but the extension host restarts)

## Files modified

(Refer to `git log` for the full diff — the key files are
`src/media/markdown.css`, `src/media/media.css`, `src/previewHost.ts`,
`src/plantuml/fences.ts`, `package.json`, and `docs/important/how-to-test.md`.)
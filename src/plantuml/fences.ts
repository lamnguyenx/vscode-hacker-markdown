import { Diagram, DiagramUri } from './diagram';
import { DiagramType } from './type';
import { makePlantumlURL } from './plantumlURL';

export interface FenceOptions {
	/** PlantUML server base URL (already trimmed). Empty string disables rewriting. */
	readonly server: string;
	/** Extra include search paths, after the Markdown file's own folder. */
	readonly includePaths: string[];
	/** The markdown document the fence came from (for relative includes). */
	readonly docUri?: DiagramUri | undefined;
}

/**
 * Fenced block rendered by markdown-it for a `puml`/`plantuml`/`uml` fence:
 * `<pre …><code class="language-puml …">escaped source</code></pre>`. The
 * hljs `code-line`/`data-line`/`dir` attributes on the `<pre>` (added by the
 * built-in engine's source-map plugin) are tolerated, not required.
 */
const PUML_FENCE_REG = /<pre([^>]*)>\s*<code([^>]*class="[^"]*language-(?:plantuml|puml|uml)[^"]*"[^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi;

/**
 * Post-processes the HTML fragment returned by `markdown.api.render`: replaces
 * every `plantuml`/`puml`/`uml` fenced block with a PlantUML-server `<img>`
 * (one per `newpage`), the same way jebbs.plantuml renders fences inside the
 * markdown-it engine — but here only our preview's copy of the fragment is
 * rewritten. With no server configured the block becomes an actionable error
 * notice instead ("PlantUML server is not set" + an Open Settings button).
 * Pure (no `vscode` import) so the real shipped code is unit-testable in Node.
 */
export function rewritePumlFences(html: string, opts: FenceOptions): string {
	const docUri: DiagramUri | undefined = opts.docUri && opts.docUri.scheme === 'file' ? opts.docUri : undefined;
	return html.replace(PUML_FENCE_REG, (full, preAttrs: string, codeAttrs: string, innerHtml: string) => {
		if (!opts.server) {
			return pumlServerError(innerHtml);
		}
		const source = unescapeHtml(innerHtml);
		const range = fenceSourceRange(preAttrs, codeAttrs, innerHtml);
		// The salt-capable PlantUML server only emits per-SALT `data-source-code`
		// ranges when the source file is known (`!pragma sourceFile`). The
		// server only knows the fence content as a string, so inject the
		// current markdown file's path here — the webview then translates the
		// 1-based, diagram-relative ranges back with the fence's `data-hmk-from`.
		// The pragma is inert on servers that do not know it.
		const diagram = new Diagram(withSourceFilePragma(source, docUri), docUri, opts.includePaths);
		const format = diagram.type === DiagramType.Ditaa ? 'png' : 'svg';
		const urls = Array.from({ length: diagram.pageCount }, (_, index) =>
			makePlantumlURL(opts.server, diagram, format, index));
		return urls.map((url) => `\n<img style="background-color:#FFF;"${range} data-hmk-puml src="${url}">`).join('');
	});
}

/**
 * Adds `!pragma sourceFile <path>` right after the diagram's opening
 * `@start…` line so the server can emit `data-source-code` salt ranges (see
 * `docs/important/plantuml-server-salt-source-code.md`). A diagram that
 * already carries the pragma is left as-is (the user's value wins).
 */
function withSourceFilePragma(source: string, docUri: DiagramUri | undefined): string {
	if (!docUri || /^\s*!pragma\s+sourceFile\b/im.test(source)) {
		return source;
	}
	return source.replace(/^@start\w+\b/im, (match) => `${match}\n!pragma sourceFile ${docUri.fsPath}`);
}

/**
 * Re-attach the fence's source span to the generated `<img>` so the webview
 * can highlight the rendered media when the cursor is inside the fence.
 *
 * The built-in engine sets `data-line` on the inner `<code>` (the block
 * token's start line, i.e. the opening fence line), not the `<pre>` — so
 * it is read from the code attributes first, falling back to the `<pre>`
 * for other renderers that place it there. The end covers every body line
 * plus the closing fence line (start + newline count, the same math the
 * built-in preview uses for a code block's end line).
 * Returns the attribute string, or '' when neither element had a `data-line`.
 */
function fenceSourceRange(preAttrs: string, codeAttrs: string, escapedSource: string): string {
	const fromMatch = /data-line="(\d+)"/i.exec(codeAttrs) ?? /data-line="(\d+)"/i.exec(preAttrs);
	if (!fromMatch) {
		return '';
	}
	const from = Number(fromMatch[1]);
	const body = unescapeHtml(escapedSource).replace(/\r\n|\r/g, '\n').replace(/\n$/, '');
	const bodyLines = body.length === 0 ? 0 : body.split('\n').length;
	const to = from + bodyLines + 1;
	return ` data-hmk-from="${from}" data-hmk-to="${to}"`;
}

/**
 * In-preview error shown when a puml fence exists but no server is configured.
 * The raw (still HTML-escaped) source is kept behind a `<details>` so the
 * diagram text is recoverable. The button is wired up in the webview
 * (`data-command="openPumlSettings"` → `previewManager.ts`) to open the
 * setting directly.
 */
function pumlServerError(escapedSource: string): string {
	return [
		`<div class="hmk-puml-error" role="alert">`,
		`<div class="hmk-puml-error-head">`,
		`<span class="hmk-puml-error-msg">PlantUML server is not set. Set <code>hackerMarkdown.plantuml.server</code> in Settings to render <code>plantuml</code>/<code>puml</code>/<code>uml</code> diagrams.</span>`,
		`<button class="hmk-puml-settings-btn" data-command="openPumlSettings">Open Settings</button>`,
		`</div>`,
		`<details class="hmk-puml-error-source">`,
		`<summary>Show diagram source</summary>`,
		`<pre><code>${escapedSource}</code></pre>`,
		`</details>`,
		`</div>`
	].join('\n');
}

/**
 * markdown-it's `escapeHtml` escapes exactly `& < > "` (see
 * `markdown-it/dist`). Decode `&amp;` last so an already-escaped literal
 * `&lt;` in the source decodes back to `&lt;`, not `<`.
 */
function unescapeHtml(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

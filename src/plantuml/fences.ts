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
const PUML_FENCE_REG = /<pre[^>]*>\s*<code[^>]*class="[^"]*language-(?:plantuml|puml|uml)[^"]*"[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;

/**
 * Post-processes the HTML fragment returned by `markdown.api.render`: replaces
 * every `plantuml`/`puml`/`uml` fenced block with a PlantUML-server `<img>`
 * (one per `newpage`), the same way jebbs.plantuml renders fences inside the
 * markdown-it engine — but here only our preview's copy of the fragment is
 * rewritten. No server configured → fences are left untouched. Pure (no
 * `vscode` import) so the real shipped code is unit-testable in Node.
 */
export function rewritePumlFences(html: string, opts: FenceOptions): string {
	if (!opts.server) {
		return html;
	}
	const docUri: DiagramUri | undefined = opts.docUri && opts.docUri.scheme === 'file' ? opts.docUri : undefined;
	return html.replace(PUML_FENCE_REG, (full, innerHtml: string) => {
		const diagram = new Diagram(unescapeHtml(innerHtml), docUri, opts.includePaths);
		const format = diagram.type === DiagramType.Ditaa ? 'png' : 'svg';
		const urls = Array.from({ length: diagram.pageCount }, (_, index) =>
			makePlantumlURL(opts.server, diagram, format, index));
		return urls.map((url) => `\n<img style="background-color:#FFF;" src="${url}">`).join('');
	});
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

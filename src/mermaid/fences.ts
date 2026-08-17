/**
 * Source spans for mermaid blocks in a markdown document.
 *
 * The mermaid markdown-it plugin (contributed via `markdown.previewScripts`)
 * renders ```mermaid fences and :::mermaid containers to `<pre class="mermaid">`
 * / `<div class="mermaid">`, but its renderer returns a raw string and **drops
 * the engine's `data-line` source map** (the built-in `source_map_data_attribute`
 * core rule sets the attribute on tokens, which custom renderer rules ignore).
 * So the fragment alone cannot tell where a mermaid block came from.
 *
 * The host has the document, so it scans it for mermaid fences/containers and
 * zips the spans onto the fragment's mermaid blocks positionally (they render
 * 1:1 in document order). This mirrors the PlantUML rewrite in
 * `src/plantuml/fences.ts`, which reads `data-line` off the rendered fence.
 *
 * Pure module (no `vscode` import) so the real shipped code is unit-testable
 * in plain Node (`tests/mermaid_check.cjs`).
 */

export interface MermaidSpan {
	/** 0-based line of the opening fence/container. */
	readonly from: number;
	/** 0-based line of the closing fence/container. */
	readonly to: number;
}

interface FenceState {
	readonly char: string;
	readonly run: number;
	readonly open: number;
	readonly mermaid: boolean;
}

interface ContainerState {
	readonly open: number;
}

/**
 * The mermaid fence/container spans in `text`, in document order. Any fence is
 * tracked as open/closed (markdown fences don't nest), so a `mermaid` marker
 * inside a non-mermaid code block never opens a span; only fences/containers
 * whose info string is `mermaid` produce an entry.
 */
export function mermaidSpans(text: string): MermaidSpan[] {
	const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
	const spans: MermaidSpan[] = [];
	let fence: FenceState | undefined;
	let container: ContainerState | undefined;

	const isFenceCloser = (trimmed: string, char: string, minRun: number): boolean =>
		trimmed.length >= minRun && trimmed[0] === char && /^[`~]+$/.test(trimmed);

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		const trimmed = raw.trim();

		if (fence) {
			if (isFenceCloser(trimmed, fence.char, fence.run)) {
				if (fence.mermaid) {
					spans.push({ from: fence.open, to: i });
				}
				fence = undefined;
			}
			continue;
		}
		if (container) {
			if (/^:{3,}\s*$/.test(trimmed)) {
				spans.push({ from: container.open, to: i });
				container = undefined;
			}
			continue;
		}

		const open = /^(\s*)(`{3,}|~{3,})\s*([a-zA-Z0-9_+-]*)(\s.*)?$/.exec(raw);
		if (open) {
			fence = {
				char: open[2]![0]!,
				run: open[2]!.length,
				open: i,
				mermaid: open[3]!.toLowerCase() === 'mermaid'
			};
			continue;
		}
		const colons = /^(\s*):{3,}\s*([a-zA-Z0-9_+-]*)(\s.*)?$/.exec(raw);
		if (colons && colons[2]!.toLowerCase() === 'mermaid') {
			container = { open: i };
		}
	}

	// Unclosed at EOF: close on the last line.
	if (fence?.mermaid) {
		spans.push({ from: fence.open, to: lines.length - 1 });
	}
	if (container) {
		spans.push({ from: container.open, to: lines.length - 1 });
	}
	return spans;
}

/**
 * Attaches `data-hmk-from`/`data-hmk-to` to each `<pre class="mermaid">` /
 * `<div class="mermaid">` opening tag in the rendered fragment, zipping the
 * document spans in order. Blocks beyond the span list get no range (graceful
 * degrade — click/cursor then falls back to the containing block).
 */
export function rewriteMermaidSpans(html: string, spans: readonly MermaidSpan[]): string {
	if (!spans.length) {
		return html;
	}
	let index = 0;
	return html.replace(/<(pre|div)\s+class="mermaid"([^>]*)>/gi, (full, tag: string, rest: string) => {
		const span = spans[index++];
		if (!span) {
			return full;
		}
		return `<${tag} class="mermaid" data-hmk-from="${span.from}" data-hmk-to="${span.to}"${rest}>`;
	});
}
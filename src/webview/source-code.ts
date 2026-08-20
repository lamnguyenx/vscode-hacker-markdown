/**
 * The `data-source-code` source ranges the new PlantUML server embeds in its
 * SVGs (see `docs/important/plantuml-server-salt-source-code.md`): a SALT
 * mockup inside an activity diagram renders as
 * `<g data-source-code="/abs/file.puml:4:1-10:1">` wrapping the mockup.
 *
 * The trailing `startLine:startCol-endLine:endCol` is **1-based** and relative
 * to the diagram source (the fence content), so the enclosing fence's
 * `data-hmk-from` (the 0-based line of the opening fence, added by
 * `src/plantuml/fences.ts` and copied onto the inlined `<svg>` root) is added
 * to translate into the current markdown document:
 *   md line = fenceFrom + sourceLine - 1
 *
 * Shared by the cursor-highlight chain (`cursor.ts`) and the reverse
 * click-to-source chain (`source.ts`).
 */

export interface SourceRange {
	/** 0-based start line in the current markdown document. */
	readonly from: number;
	/** 0-based end line (inclusive). */
	readonly to: number;
}

/** Parses `data-source-code` on `el`, translated into document lines. */
export function sourceCodeRange(el: Element): SourceRange | undefined {
	const value = el.getAttribute('data-source-code');
	if (!value) {
		return undefined;
	}
	const match = /:(\d+):\d+-(\d+):\d+$/.exec(value);
	if (!match) {
		return undefined;
	}
	const start = Number(match[1]);
	const end = Number(match[2]);
	if (!isFinite(start) || !isFinite(end) || start < 1 || end < start) {
		return undefined;
	}
	const fence = el.closest<HTMLElement>('[data-hmk-from]');
	const fenceFrom = Number(fence?.getAttribute('data-hmk-from') ?? 0);
	return { from: fenceFrom + start - 1, to: fenceFrom + end - 1 };
}

/**
 * A salt mockup element inside an inlined PlantUML SVG: either a server-tagged
 * note mockup (`data-source-code`) or a procedure-rendered activity mockup
 * whose range the webview attached (`data-hmk-from`/`data-hmk-to`, absolute,
 * added by {@link attachMockupRanges}). The `<svg>` root itself carries
 * `data-hmk-from` too but is the whole-diagram media, not a mockup.
 */
export function isSaltMockup(el: Element): boolean {
	return el.hasAttribute('data-source-code')
		|| (el.closest('svg') !== null && el.hasAttribute('data-hmk-from') && el.tagName.toLowerCase() !== 'svg');
}

/** The document range of a salt mockup (absolute, 0-based, inclusive). */
export function mockupRange(el: Element): SourceRange | undefined {
	if (el.hasAttribute('data-source-code')) {
		return sourceCodeRange(el);
	}
	if (!isSaltMockup(el)) {
		return undefined;
	}
	const from = Number(el.getAttribute('data-hmk-from'));
	const to = Number(el.getAttribute('data-hmk-to'));
	if (!isFinite(from) || !isFinite(to) || from < 0 || to < from) {
		return undefined;
	}
	return { from, to };
}

/**
 * Zips the host-provided `data-hmk-salts` entries (first-occurrence `SALT(x)`
 * invocation lines per fence, encoded as `line:alias` pairs) onto the SVG's
 * rangeless mockup `<image>`s, in SVG document order — one mockup per distinct
 * alias, in first-invocation order (see `src/plantuml/invocations.ts`). Each
 * image gets `data-hmk-from`/`data-hmk-to` for the invocation line and
 * `data-hmk-alias` for the alias name. Also attaches procedure body ranges from
 * `data-hmk-procs` (`from:to:alias` triples) as `data-hmk-proc` arrays on the
 * svg root. Server-tagged note mockups are untouched.
 */
export function attachMockupRanges(root: HTMLElement): void {
	for (const svg of Array.from(root.querySelectorAll<SVGSVGElement>('svg[data-hmk-salts]'))) {
		const entries = (svg.getAttribute('data-hmk-salts') ?? '')
			.split(',')
			.map((part) => {
				const colon = part.indexOf(':');
				if (colon < 0) return null;
				const line = Number(part.slice(0, colon));
				const alias = part.slice(colon + 1);
				return isFinite(line) && alias ? { line, alias } : null;
			})
			.filter((e): e is { line: number; alias: string } => e !== null);
		if (!entries.length) {
			continue;
		}
		const mockups = Array.from(svg.querySelectorAll<SVGImageElement>('image'))
			.filter((img) => !img.closest('[data-source-code]'));
		mockups.forEach((img, index) => {
			const entry = entries[index];
			if (!entry) {
				return;
			}
			img.setAttribute('data-hmk-from', String(entry.line));
			img.setAttribute('data-hmk-to', String(entry.line));
			img.setAttribute('data-hmk-alias', entry.alias);
		});

		// Parse procedure body ranges and store on the svg root.
		const procsRaw = svg.getAttribute('data-hmk-procs') ?? '';
		if (procsRaw) {
			const ranges = procsRaw.split(';').map((part) => {
				const segments = part.split(':');
				if (segments.length < 3) return null;
				const from = Number(segments[0]);
				const to = Number(segments[1]);
				const alias = segments.slice(2).join(':');
				return isFinite(from) && isFinite(to) && from >= 0 && to >= from && alias ? { from, to, alias } : null;
			}).filter((r): r is { from: number; to: number; alias: string } => r !== null);
			if (ranges.length) {
				svg.setAttribute('data-hmk-procs', JSON.stringify(ranges));
			}
		}
	}
}
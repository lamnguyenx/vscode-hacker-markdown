import { previewEl } from './dom';
import { dataLineElements } from './line-sync';
import { isSaltMockup, mockupRange } from './source-code';

/**
 * Cursor sync: when the editing cursor moves in the Markdown editor, the host
 * posts a `cursorLine` message and we highlight the corresponding preview
 * block with a blue outline box (.hmk-cursor).
 *
 * Resolution order (the fallback chain):
 *   1. a SALT block inside an inlined PlantUML SVG — an element whose
 *      `data-source-code` span (translated via the enclosing fence) contains
 *      the line;
 *   2. rendered media — an element whose `data-hmk-from`..`data-hmk-to` source
 *      span contains the line (a plantuml/puml/uml fence rendered to an
 *      `<img>` by `src/plantuml/fences.ts`);
 *   3. exact line — a block element with `data-line === line`;
 *   4. containing block — the element with the greatest `data-line <= line`
 *      (the paragraph / code fence / heading the cursor is in, innermost
 *      first);
 *   5. nothing in range -> no highlight.
 */

let lastCursorLine = -1;

export function setCursorLine(line: number): void {
	lastCursorLine = line;
	applyCursorHighlight(line);
}

/** The source line currently highlighted (or -1). */
export function getCursorLine(): number {
	return lastCursorLine;
}

/**
 * The element whose box the cursor highlight draws for `line` (media span /
 * exact / containing block, with the code-fence hoist applied). Scroll sync
 * centers the same element, so the box and the centering always agree.
 */
export function cursorBoxForLine(line: number): HTMLElement | null {
	const target = resolveCursorTarget(line);
	return target ? blockTarget(target) : null;
}

/** Re-resolve and re-apply the highlight (renders recreate every element). */
export function reapplyCursorHighlight(): void {
	if (lastCursorLine >= 0) {
		applyCursorHighlight(lastCursorLine);
	}
}

/** Remove any active cursor highlight (e.g. when the preview empties). */
export function clearCursorHighlight(): void {
	for (const el of previewEl.querySelectorAll<HTMLElement>('.hmk-cursor')) {
		el.classList.remove('hmk-cursor');
	}
}

function applyCursorHighlight(line: number): void {
	clearCursorHighlight();
	const target = resolveCursorTarget(line);
	if (target) {
		blockTarget(target).classList.add('hmk-cursor');
	}
}

/**
 * The element the outline box is drawn around. A fenced block's `data-line`
 * sits on the inner `<code>` (the built-in engine can only mark the code
 * element — `preview-src/scroll-sync.ts` hoists it the same way), so the box
 * wraps the whole `<pre>` block. Rendered media inside a pan/zoom frame
 * (plantuml/…) is boxed at the *frame* (`.hmk-frame`), not the inner img/svg,
 * so the box outlines the whole zoomable diagram, matching the frame's own
 * border box. A SALT block inside an inlined SVG is boxed at its own `<g>`
 * (the outline follows the pan/zoom transform of the diagram), not hoisted to
 * the frame — hoisting would outline the whole diagram instead of the mockup.
 */
function blockTarget(el: HTMLElement): HTMLElement {
	if (isSaltMockup(el)) {
		return el;
	}
	if (el.tagName === 'CODE' && el.parentElement && el.parentElement.tagName === 'PRE') {
		return el.parentElement;
	}
	const frame = el.closest<HTMLElement>('.hmk-frame');
	if (frame) {
		return frame;
	}
	// Mermaid's `.mermaid` pre is `display: unset` (inline), so its own box is
	// a sliver; box the whole `.mermaid-wrapper` (the visible diagram) instead.
	const mermaid = el.closest<HTMLElement>('.mermaid-wrapper');
	if (mermaid) {
		return mermaid;
	}
	return el;
}

/** The rendered media whose fence source span contains `line`. */
function mediaForLine(line: number): HTMLElement | null {
	for (const el of Array.from(previewEl.querySelectorAll<HTMLElement>('[data-hmk-from][data-hmk-to]'))) {
		const from = Number(el.dataset.hmkFrom);
		const to = Number(el.dataset.hmkTo);
		if (!isNaN(from) && !isNaN(to) && line >= from && line <= to) {
			return el;
		}
	}
	return null;
}

/**
 * The SALT mockup inside an inlined PlantUML SVG whose source span contains
 * `line` — server-tagged notes (`data-source-code`) and procedure-rendered
 * activity mockups (`data-hmk-from`/`data-hmk-to`, attached by
 * `attachMockupRanges`), most specific first (largest `from`). Runs before
 * the media check: the enclosing `<svg>` carries the whole-fence
 * `data-hmk-from`/`data-hmk-to`, which would otherwise always shadow the
 * exact mockup.
 */
function saltForLine(line: number): HTMLElement | null {
	let best: HTMLElement | null = null;
	let bestFrom = -Infinity;
	for (const el of Array.from(previewEl.querySelectorAll<HTMLElement>('[data-source-code], svg [data-hmk-from][data-hmk-to]'))) {
		const range = mockupRange(el);
		if (!range) {
			continue;
		}
		if (line >= range.from && line <= range.to && range.from >= bestFrom) {
			bestFrom = range.from;
			best = el;
		}
	}
	if (best) {
		return best;
	}

	// 0b. Procedure body range: if the line falls inside any !procedure / !endprocedure
	// block, highlight the mockup whose alias matches.
	for (const svg of Array.from(previewEl.querySelectorAll<SVGSVGElement>('svg[data-hmk-procs]'))) {
		let procs: { from: number; to: number; alias: string }[] | undefined;
		try {
			procs = JSON.parse(svg.getAttribute('data-hmk-procs') ?? '') as typeof procs;
		} catch {
			continue;
		}
		if (!procs || !procs.length) {
			continue;
		}
		for (const proc of procs) {
			if (line >= proc.from && line <= proc.to) {
				const image = svg.querySelector(`image[data-hmk-alias="${proc.alias}"]`) as HTMLElement | null;
				if (image && isSaltMockup(image)) {
					return image;
				}
			}
		}
	}

	return null;
}

function resolveCursorTarget(line: number): HTMLElement | null {
	// 1. SALT blocks inside inlined SVGs — the exact mockup, before the
	// whole-diagram media span below.
	const salt = saltForLine(line);
	if (salt) {
		return salt;
	}

	// 2. Rendered media. Must run before the containing-block fallback: inside
	// a puml fence there is no `data-line` element, so the fallback alone would
	// highlight the sibling above the diagram instead.
	const media = mediaForLine(line);
	if (media) {
		return media;
	}

	// 3./4. Exact line, falling back to the greatest `data-line <= line`.
	// Iterating keeps the innermost element (last in document order) for
	// equal line values, so nested blocks (li inside ol, p inside blockquote)
	// resolve to the most specific one.
	const els = dataLineElements();
	let exact: HTMLElement | null = null;
	let fallback: HTMLElement | null = null;
	let bestLine = -Infinity;
	for (const el of els) {
		const l = Number(el.dataset.line);
		if (isNaN(l)) {
			continue;
		}
		if (l === line) {
			exact = el;
		} else if (l <= line && l >= bestLine) {
			bestLine = l;
			fallback = el;
		}
	}
	return exact ?? fallback;
}

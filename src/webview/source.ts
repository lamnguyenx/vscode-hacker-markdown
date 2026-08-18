import { dataLineElements } from './line-sync';
import { mockupRange } from './source-code';

/**
 * Click-to-source: resolve a click inside the preview to a source line, the
 * reverse of `cursor.ts` (line -> element). Resolution order:
 *   1. a SALT block inside an inlined PlantUML SVG — the click is inside
 *      `[data-source-code]` (a mockup's exact source span, translated via the
 *      enclosing fence) -> the whole range, so the editor selects the exact
 *      code that produced the mockup;
 *   2. rendered media — the click is inside `[data-hmk-from]` or inside a
 *      `.hmk-frame` / `.mermaid-wrapper` wrapping one (a plantuml/puml/uml
 *      fence rendered to an `<img>` by `src/plantuml/fences.ts`) -> the
 *      fence's opening line;
 *   3. exact block — the target or an ancestor has `data-line` (the engine
 *      puts it on the inner `<code>` for fenced blocks, `closest` finds it);
 *   4. geometric fallback — the last `data-line` element whose top is above
 *      the click (the block the reader is looking at on a blank line / pre
 *      padding), matching the cursor-sync containing-block semantics.
 * Nothing in range -> undefined (no jump).
 */

export interface ClickSource {
	/** 0-based line to jump to. */
	readonly line: number;
	/** When set, select the whole source range `from`..`to` (0-based, inclusive). */
	readonly from?: number;
	readonly to?: number;
}

export function sourceLineForClick(target: Element | null, clickY: number): ClickSource | undefined {
	if (!target) {
		return undefined;
	}
	// 1. SALT mockup inside an inlined SVG: server-tagged notes
	// (`data-source-code`) or procedure-rendered activity mockups (the
	// `data-hmk-from`/`data-hmk-to` attachMockupRanges added) — jump to the
	// exact source range, before the whole-diagram media span below.
	const salt = target.closest<HTMLElement>('[data-source-code], svg [data-hmk-from][data-hmk-to]');
	if (salt) {
		const range = mockupRange(salt);
		if (range) {
			return { line: range.from, from: range.from, to: range.to };
		}
	}
	// 2. Rendered media: the img carries `data-hmk-from`; a click on a
	// wrapper's padding has no such ancestor (the media is a child, not an
	// ancestor), so read it from `.hmk-frame` / `.mermaid-wrapper` wrappers.
	// Drag-releases no longer reach this handler (main.ts skips moved clicks),
	// so any click inside a wrapper is deliberate.
	let media = target.closest<HTMLElement>('[data-hmk-from]');
	if (!media) {
		const wrapper = target.closest<HTMLElement>('.hmk-frame, .mermaid-wrapper');
		media = wrapper ? wrapper.querySelector<HTMLElement>('[data-hmk-from]') : null;
	}
	if (media) {
		const from = Number(media.getAttribute('data-hmk-from'));
		if (!isNaN(from)) {
			return { line: from };
		}
	}
	// 3. Block element with `data-line`.
	const block = target.closest<HTMLElement>('[data-line]');
	if (block) {
		const line = Number(block.getAttribute('data-line'));
		if (!isNaN(line)) {
			return { line };
		}
	}
	// 4. Geometric fallback: the nearest block whose top is above the click.
	let best: HTMLElement | null = null;
	for (const el of dataLineElements()) {
		if (el.getBoundingClientRect().top <= clickY) {
			best = el;
		}
	}
	if (best) {
		const line = Number(best.getAttribute('data-line'));
		if (!isNaN(line)) {
			return { line };
		}
	}
	return undefined;
}
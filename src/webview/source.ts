import { dataLineElements } from './line-sync';

/**
 * Click-to-source: resolve a click inside the preview to a source line, the
 * reverse of `cursor.ts` (line -> element). Resolution order:
 *   1. rendered media — the click is inside `[data-hmk-from]` or inside a
 *      `.hmk-frame` wrapping one (a plantuml/puml/uml fence rendered to an
 *      `<img>` by `src/plantuml/fences.ts`) -> the fence's opening line;
 *   2. exact block — the target or an ancestor has `data-line` (the engine
 *      puts it on the inner `<code>` for fenced blocks, `closest` finds it);
 *   3. geometric fallback — the last `data-line` element whose top is above
 *      the click (the block the reader is looking at on a blank line / pre
 *      padding), matching the cursor-sync containing-block semantics.
 * Nothing in range -> undefined (no jump).
 */
export function sourceLineForClick(target: Element | null, clickY: number): number | undefined {
	if (!target) {
		return undefined;
	}
	// 1. Rendered media: the img carries `data-hmk-from`; a click on a
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
			return from;
		}
	}
	// 2. Block element with `data-line`.
	const block = target.closest<HTMLElement>('[data-line]');
	if (block) {
		const line = Number(block.getAttribute('data-line'));
		if (!isNaN(line)) {
			return line;
		}
	}
	// 3. Geometric fallback: the nearest block whose top is above the click.
	let best: HTMLElement | null = null;
	for (const el of dataLineElements()) {
		if (el.getBoundingClientRect().top <= clickY) {
			best = el;
		}
	}
	if (best) {
		const line = Number(best.getAttribute('data-line'));
		if (!isNaN(line)) {
			return line;
		}
	}
	return undefined;
}
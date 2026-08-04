import { previewEl } from './dom';
import { elementForLine } from './line-sync';
import { markProgrammaticScroll } from './programmatic-scroll';

/**
 * Reading-position targets recorded from the OLD document (before the DOM
 * swap in `render`), so the reading position returns exactly where it was.
 */
export interface AnchorView {
	anchorTop?: number;
	nextTop?: number;
}

interface AnchorGuard {
	line: number;
	anchorEl: HTMLElement;
	anchorTop: number;
	nextTop?: number;
	lastScrollY: number;
	deadline: number;
	started: number;
	settleCount: number;
	observer: MutationObserver;
	timer: number | undefined;
}

let anchorGuard: AnchorGuard | undefined;

export function hasActiveAnchorGuard(): boolean {
	return !!anchorGuard;
}

export function cancelAnchorGuard(): void {
	if (!anchorGuard) {
		return;
	}
	anchorGuard.observer.disconnect();
	clearTimeout(anchorGuard.timer);
	anchorGuard = undefined;
}

/**
 * Diagrams (mermaid/puml/KaTeX, ...) render asynchronously after the HTML
 * swap: they replace their placeholder and grow the layout, pushing the
 * anchored line away. Watch for DOM mutations and restore the anchored
 * line's position until the layout settles (or the user takes over
 * scrolling). If the anchor element was replaced, the anchor falls through
 * to the next line element.
 */
export function keepAnchor(line: number, oldView: AnchorView | undefined): void {
	cancelAnchorGuard();
	if (line < 0 || !oldView) {
		return;
	}
	const anchorEl = elementForLine(line);
	if (!anchorEl) {
		return;
	}
	const guard: AnchorGuard = {
		line,
		anchorEl,
		anchorTop: oldView.anchorTop ?? anchorEl.getBoundingClientRect().top,
		nextTop: oldView.nextTop,
		lastScrollY: window.scrollY,
		deadline: Date.now() + 3000,
		started: Date.now(),
		settleCount: 0,
		observer: new MutationObserver(() => {
			guard.deadline = Date.now() + 3000;
			clearTimeout(guard.timer);
			guard.timer = setTimeout(() => settleAnchor(guard), 150);
		}),
		timer: undefined
	};
	guard.observer.observe(previewEl, { childList: true, subtree: true });
	anchorGuard = guard;
	guard.timer = setTimeout(() => settleAnchor(guard), 400);
}

function settleAnchor(guard: AnchorGuard): void {
	if (anchorGuard !== guard) {
		return;
	}
	if (Date.now() > guard.deadline || Date.now() - guard.started > 10000) {
		cancelAnchorGuard();
		return;
	}
	// A scroll the guard did not perform means the user took over.
	if (Math.abs(window.scrollY - guard.lastScrollY) > 4) {
		cancelAnchorGuard();
		return;
	}
	let el = guard.anchorEl;
	if (!el.isConnected) {
		el = elementForLine(guard.line) ?? el;
	}
	if (!el.isConnected) {
		cancelAnchorGuard();
		return;
	}
	const isAnchor = el === guard.anchorEl;
	const expected = isAnchor ? guard.anchorTop : (guard.nextTop ?? guard.anchorTop);
	const drift = el.getBoundingClientRect().top - expected;
	if (Math.abs(drift) > 4) {
		guard.settleCount = 0;
		markProgrammaticScroll();
		window.scrollBy(0, drift);
		guard.lastScrollY = window.scrollY;
	} else {
		guard.settleCount++;
		if (guard.settleCount >= 2) {
			cancelAnchorGuard();
			return;
		}
	}
	guard.timer = setTimeout(() => settleAnchor(guard), 250);
}

import { previewEl, toolbar, post } from './dom';
import { markProgrammaticScroll } from './programmatic-scroll';

let scrollThrottleTimer: number | undefined;

/** Drop trailing events while a frame is pending (fit a true `setTimeout` throttle). */
export function throttle(fn: () => void, ms: number): void {
	if (scrollThrottleTimer) {
		return;
	}
	scrollThrottleTimer = setTimeout(() => {
		scrollThrottleTimer = undefined;
		fn();
	}, ms);
}

export function dataLineElements(): HTMLElement[] {
	return Array.from(previewEl.querySelectorAll<HTMLElement>('[data-line]'));
}

function toolbarBottom(): number {
	const rect = toolbar.getBoundingClientRect();
	return rect.bottom;
}

/** The topmost source line visible in the viewport (best effort). */
export function topmostVisibleLine(): number {
	const top = toolbarBottom();
	let best = -1;
	let bestTop = Infinity;
	for (const el of dataLineElements()) {
		const rect = el.getBoundingClientRect();
		if (rect.bottom >= top && rect.top < window.innerHeight) {
			const t = Math.max(rect.top, top);
			if (t < bestTop) {
				bestTop = t;
				best = Number(el.dataset.line) || 0;
			}
		}
	}
	return best;
}

/** The element for a source line, or the next line after it (best effort). */
export function elementForLine(line: number): HTMLElement | null {
	const els = dataLineElements();
	let target: HTMLElement | null = null;
	let targetGap = Infinity;
	for (const el of els) {
		const l = Number(el.dataset.line) || 0;
		if (l === line) {
			return el;
		}
		const gap = l - line;
		if (gap > 0 && gap < targetGap) {
			targetGap = gap;
			target = el;
		}
	}
	return target || els[els.length - 1] || null;
}

/** The preview's scrollable element (the document). */
function scroller(): Element {
	return document.scrollingElement ?? document.documentElement;
}

/**
 * Scroll so `el` is as close to the vertical center of the preview window as
 * the page bounds allow. Near the top/bottom of the document — or when the
 * document is shorter than the viewport — it clamps to the closest reachable
 * position, i.e. "as centered as the content allows". Flagged programmatic
 * so the resulting `scroll` event is not read as a user scroll (and does not
 * cancel the anchor guard).
 *
 * The center is the inner window's midpoint on purpose, not the toolbar's
 * bottom: `position: sticky` on the toolbar is not a reliable boundary inside
 * the webview frame, and the resulting ~toolbar-height offset is negligible.
 */
export function centerElement(el: HTMLElement | null): void {
	markProgrammaticScroll();
	if (!el) {
		return;
	}
	const vpHeight = window.innerHeight;
	if (vpHeight <= 0) {
		el.scrollIntoView({ block: 'nearest' });
		return;
	}
	const rect = el.getBoundingClientRect();
	const elCenter = rect.top + rect.height / 2;
	const desired = window.scrollY + (elCenter - vpHeight / 2);
	const maxScroll = Math.max(0, scroller().scrollHeight - vpHeight);
	const next = Math.min(maxScroll, Math.max(0, desired));
	if (Math.abs(next - window.scrollY) > 0.5) {
		window.scrollTo(0, next);
	}
}

/**
 * Minimal reveal (used after a re-render to hand the exact reading position
 * to the anchor guard, which then restores it to the pixel — centering here
 * would steal the reader's place).
 */
export function revealLine(line: number): void {
	markProgrammaticScroll();
	const target = elementForLine(line);
	if (target) {
		target.scrollIntoView({ block: 'nearest' });
	}
}

/** Post the current topmost visible line (scroll-sync), if it changed. */
export function reportScrollLine(lastLine: number): number {
	const line = topmostVisibleLine();
	if (line >= 0 && line !== lastLine) {
		post({ type: 'scrollLine', line });
		return line;
	}
	return lastLine;
}

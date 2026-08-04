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

export function scrollToLine(line: number): void {
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

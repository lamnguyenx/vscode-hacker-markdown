import { previewEl } from './dom';

export interface StaleBlock {
	/** Count of `data-line` elements before this block (position-based key). */
	gapIndex: number;
	/** Order within the anonymous gap (stable across edits). */
	gapOrder: number;
	el: Element;
	height?: number;
}

/**
 * Snapshots the old block-level diagram elements so they can be kept in
 * place while they re-render.
 *
 * While a diagram re-renders, its space collapses before the new render
 * lands: puml-style `<img>` placeholders have no height until the new URL
 * loads, and container renderers (mermaid/KaTeX) empty their placeholder
 * before filling it. That collapse jumps the content below. Keep the old
 * rendered block in flow (imgs, faded, with a "Re-rendering" badge) or
 * hold the placeholder at its old height (containers) until the new
 * render replaces it.
 *
 * Old and new blocks are matched by position: the anonymous (data-line
 * free) svg/img-bearing blocks are indexed by the count of data-line
 * elements before them plus their order within the gap, which stays
 * stable across edits (line numbers themselves shift when the source
 * changes).
 */
export function snapshotStaleBlocks(): StaleBlock[] {
	const out: StaleBlock[] = [];
	let lineCount = 0;
	let gapOrder = 0;
	for (const child of previewEl.children) {
		if (child.hasAttribute('data-line')) {
			lineCount++;
			gapOrder = 0;
		} else if (child.tagName === 'IMG' || child.tagName.toUpperCase() === 'SVG' || child.querySelector('svg, img')) {
			// rect height (not offsetHeight): renderer placeholders are
			// often inline (e.g. mermaid's pre has style="all: unset").
			const height = child.getBoundingClientRect().height;
			if (height > 60) {
				out.push({ gapIndex: lineCount, gapOrder: gapOrder++, el: child, height });
			}
		}
	}
	return out;
}

/** The new anonymous-block index, matched positionally against the snapshot. */
function newGapBlocks(): StaleBlock[] {
	const out: StaleBlock[] = [];
	let lineCount = 0;
	let gapOrder = 0;
	for (const child of previewEl.children) {
		if (child.hasAttribute('data-line')) {
			lineCount++;
			gapOrder = 0;
		} else {
			out.push({ gapIndex: lineCount, gapOrder: gapOrder++, el: child });
		}
	}
	return out;
}

export function keepStaleBlocks(stale: StaleBlock[]): void {
	if (!stale.length) {
		return;
	}
	const fresh = newGapBlocks();
	for (const s of stale) {
		const target = fresh.find((b) => b.gapIndex === s.gapIndex && b.gapOrder === s.gapOrder);
		if (!target) {
			continue;
		}
		// Only pair same kinds (img<->img, container<->container): a kind
		// switch means the old element is not this placeholder's previous
		// render, and holding an img in a min-height wrapper never settles.
		const isImg = s.el.tagName === 'IMG';
		if (isImg !== (target.el.tagName === 'IMG')) {
			continue;
		}
		if (isImg) {
			keepStaleImg(s.el as HTMLImageElement, target.el as HTMLImageElement);
		} else {
			holdPlaceholderHeight(s.el, target.el, s.height ?? 0);
		}
	}
}

function keepStaleImg(oldImg: HTMLImageElement, newImg: HTMLImageElement): void {
	const holder = document.createElement('div');
	holder.className = 'hmk-stale';
	oldImg.classList.add('hmk-stale-media');
	holder.appendChild(oldImg);
	newImg.before(holder);
	const deadline = Date.now() + 8000;
	const poll = () => {
		if (!holder.isConnected || newImg.complete || Date.now() > deadline) {
			holder.remove();
			return;
		}
		setTimeout(poll, 100);
	};
	setTimeout(poll, 50);
}

function holdPlaceholderHeight(oldEl: Element, newEl: Element, height: number): void {
	if (height <= 0) {
		return;
	}
	// Wrap the placeholder in a min-height holder: renderers replace the
	// placeholder element itself, so a min-height on it would die with it.
	const holder = document.createElement('div');
	holder.className = 'hmk-stale-holder';
	holder.style.minHeight = height + 'px';
	newEl.replaceWith(holder);
	holder.appendChild(newEl);
	const finish = () => {
		if (!holder.isConnected) {
			return;
		}
		// Unwrap: put the rendered content back in flow and drop the
		// holder entirely, so no leftover wrapper confuses the next
		// render's snapshot.
		holder.replaceWith(...holder.childNodes);
	};
	const observer = new MutationObserver(() => {
		if (holder.querySelector('svg, img')) {
			observer.disconnect();
			// Keep the badge visible briefly even for fast renders, so the
			// re-rendering state is perceivable (and the height hold does
			// not flicker the layout).
			setTimeout(finish, 120);
		}
	});
	observer.observe(holder, { childList: true, subtree: true });
	setTimeout(() => {
		observer.disconnect();
		finish();
	}, 8000);
}

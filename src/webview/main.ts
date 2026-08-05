import { toolbar, docNameEl, previewEl, emptyEl, post } from './dom';
import { consumeProgrammaticScroll } from './programmatic-scroll';
import { throttle, topmostVisibleLine, elementForLine, centerElement, revealLine, dataLineElements, reportScrollLine } from './line-sync';
import { keepAnchor, cancelAnchorGuard, hasActiveAnchorGuard, type AnchorView } from './anchor';
import { snapshotStaleBlocks, keepStaleBlocks } from './stale';
import {
	snapshotFrameStates,
	unwrapFrames,
	scanFrames,
	disposeFrames,
	scheduleFrameScan
} from './frames';
import { setCursorLine, reapplyCursorHighlight, clearCursorHighlight, cursorBoxForLine } from './cursor';

// The page may load after the host already pushed its state (webview
// creation races the page load), so ask the host to re-push on load.
post({ type: 'ready' });

let lastScrollLine = -1;

function render(html: string): void {
	// Keep the reading position anchored across re-renders: remember the
	// topmost visible line (and the line after it) in the OLD document,
	// then restore them after the swap. The old positions are the ground
	// truth — the reading position must return to exactly where it was.
	const anchorLine = topmostVisibleLine();
	const oldEls = dataLineElements();
	const oldAnchorEl = anchorLine >= 0 ? elementForLine(anchorLine) : null;
	const oldNextEl = oldAnchorEl ? oldEls[oldEls.indexOf(oldAnchorEl) + 1] || null : null;
	const oldView: AnchorView = {
		anchorTop: oldAnchorEl ? oldAnchorEl.getBoundingClientRect().top : undefined,
		nextTop: oldNextEl ? oldNextEl.getBoundingClientRect().top : undefined
	};
	// Unwrap the pan/zoom frames before the swap so the stale-diagram
	// keepers below see the same raw blocks the new fragment will have
	// (a framed img would mismatch the new raw img and skip the keeper).
	snapshotFrameStates();
	unwrapFrames();
	const stale = snapshotStaleBlocks();
	previewEl.innerHTML = html;
	previewEl.hidden = false;
	emptyEl.hidden = true;
	// Keep old diagrams in place while they re-render (before the anchor
	// scroll so the layout it measures is already stable).
	keepStaleBlocks(stale);
	if (anchorLine >= 0) {
		// Restore the reading position (minimal reveal); the anchor guard below
		// then holds it to the pixel while async renderers settle.
		revealLine(anchorLine);
	}
	// Re-frame the fragment's block-level imgs/svgs (plantuml, ...) and
	// restore their pan/zoom state.
	scanFrames();
	window.dispatchEvent(new CustomEvent('vscode.markdown.updateContent'));
	// The scripts render async and grow the layout after the anchor scroll
	// above, so hold the position until they settle.
	keepAnchor(anchorLine, oldView);
	// The DOM swap recreated every element, so re-apply the cursor highlight
	// from the last `cursorLine` message (renders are decoupled from it).
	reapplyCursorHighlight();
}

function setEmpty(): void {
	cancelAnchorGuard();
	disposeFrames();
	previewEl.innerHTML = '';
	previewEl.hidden = true;
	emptyEl.hidden = false;
	docNameEl.textContent = '';
	clearCursorHighlight();
}

window.addEventListener('message', (event) => {
	const message = event.data as { type?: string; [key: string]: unknown } | undefined;
	if (!message || typeof message.type !== 'string') {
		return;
	}
	switch (message.type) {
		case 'setDoc':
			docNameEl.textContent = String(message.name ?? '');
			break;
		case 'render':
			render(String(message.html ?? ''));
			break;
		case 'empty':
			setEmpty();
			break;
		case 'scrollToLine': {
			// Center the same element the cursor highlight boxes (media span /
			// containing block), falling back to the rough line block.
			const line = Number(message.line) || 0;
			const target = cursorBoxForLine(line) ?? elementForLine(line);
			centerElement(target);
			break;
		}
		case 'cursorLine':
			setCursorLine(Number(message.line) || 0);
			break;
	}
});

// Contributed preview scripts replace their placeholders asynchronously
// after each content update, so re-scan for late-rendered svgs and re-apply
// the cursor highlight (the swap may have replaced the highlighted element).
new MutationObserver(() => {
	scheduleFrameScan();
	reapplyCursorHighlight();
}).observe(previewEl, { childList: true, subtree: true });

previewEl.addEventListener('click', (e) => {
	if (e.defaultPrevented) {
		return;
	}
	const target = e.target as Element | null;
	// Buttons injected into the rendered fragment (e.g. the PlantUML
	// "Open Settings" error button) post a command to the extension host.
	const commandEl = target?.closest('[data-command]');
	if (commandEl) {
		e.preventDefault();
		const id = commandEl.getAttribute('data-command') ?? '';
		post({ type: 'command', id });
		return;
	}
	const anchor = target?.closest('a[href]');
	if (!anchor) {
		return;
	}
	const href = anchor.getAttribute('data-href') || anchor.getAttribute('href') || '';
	if (href.startsWith('#')) {
		const fragmentTarget = document.getElementById(href.slice(1));
		if (fragmentTarget) {
			e.preventDefault();
			fragmentTarget.scrollIntoView({ block: 'start' });
		}
		return;
	}
	if (href) {
		e.preventDefault();
		post({ type: 'openLink', href });
	}
});

toolbar.addEventListener('click', (e) => {
	const button = (e.target as Element | null)?.closest('.toolbar-button');
	if (!button) {
		return;
	}
	const id = button.getAttribute('data-command') ?? '';
	post({ type: 'command', id });
});

window.addEventListener('scroll', () => {
	// A scroll we flagged as programmatic is consumed; anything else while
	// the anchor guard is live means the user took over scrolling.
	if (!consumeProgrammaticScroll() && hasActiveAnchorGuard()) {
		cancelAnchorGuard();
	}
	throttle(() => {
		lastScrollLine = reportScrollLine(lastScrollLine);
	}, 120);
}, { passive: true });

(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const toolbar = document.querySelector('.toolbar');
	const docNameEl = toolbar.querySelector('.doc-name');
	const previewEl = document.getElementById('preview');
	const emptyEl = document.getElementById('empty');

	let scrollThrottleTimer = undefined;
	let lastScrollLine = -1;

	// While the anchor guard is active, any programmatic scroll (from the
	// anchor restore itself) must not be mistaken for a user scroll. The flag
	// is consumed by the scroll event it produces; the timer is only a safety
	// net for scrolls that produce no event (element already in place).
	let anchorGuard = undefined;
	let programmaticScroll = false;
	let programmaticScrollTimer = undefined;

	function markProgrammaticScroll() {
		programmaticScroll = true;
		clearTimeout(programmaticScrollTimer);
		programmaticScrollTimer = setTimeout(() => {
			programmaticScroll = false;
		}, 120);
	}

	function throttle(fn, ms) {
		if (scrollThrottleTimer) {
			return;
		}
		scrollThrottleTimer = setTimeout(() => {
			scrollThrottleTimer = undefined;
			fn();
		}, ms);
	}

	function dataLineElements() {
		return Array.from(previewEl.querySelectorAll('[data-line]'));
	}

	function toolbarBottom() {
		const rect = toolbar.getBoundingClientRect();
		return rect.bottom;
	}

	/** The topmost source line visible in the viewport (best effort). */
	function topmostVisibleLine() {
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

	function elementForLine(line) {
		const els = dataLineElements();
		let target = null;
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

	function scrollToLine(line) {
		markProgrammaticScroll();
		const target = elementForLine(line);
		if (target) {
			target.scrollIntoView({ block: 'nearest' });
		}
	}

	function cancelAnchorGuard() {
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
	 * to the next line element. Targets are the positions recorded from the
	 * OLD document (before the swap), so the reading position returns exactly
	 * where it was before the re-render.
	 */
	function keepAnchor(line, oldView) {
		cancelAnchorGuard();
		if (line < 0 || !oldView) {
			return;
		}
		const anchorEl = elementForLine(line);
		if (!anchorEl) {
			return;
		}
		const guard = {
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

	function settleAnchor(guard) {
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
			el = elementForLine(guard.line);
		}
		if (!el) {
			cancelAnchorGuard();
			return;
		}
		const isAnchor = el === guard.anchorEl;
		const expected = isAnchor ? guard.anchorTop : (guard.nextTop ?? guard.anchorTop);
		if (expected === undefined) {
			cancelAnchorGuard();
			return;
		}
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

	function render(html) {
		// Keep the reading position anchored across re-renders: remember the
		// topmost visible line (and the line after it) in the OLD document,
		// then restore them after the swap. The old positions are the ground
		// truth — the reading position must return to exactly where it was.
		const anchorLine = topmostVisibleLine();
		const oldEls = dataLineElements();
		const oldAnchorEl = anchorLine >= 0 ? elementForLine(anchorLine) : null;
		const oldNextEl = oldAnchorEl ? oldEls[oldEls.indexOf(oldAnchorEl) + 1] || null : null;
		const oldView = {
			anchorTop: oldAnchorEl ? oldAnchorEl.getBoundingClientRect().top : undefined,
			nextTop: oldNextEl ? oldNextEl.getBoundingClientRect().top : undefined
		};
		previewEl.innerHTML = html;
		previewEl.hidden = false;
		emptyEl.hidden = true;
		if (anchorLine >= 0) {
			scrollToLine(anchorLine);
		}
		// Notify contributed preview scripts (e.g. the mermaid renderer) that
		// the document content changed, like the built-in preview does.
		window.dispatchEvent(new CustomEvent('vscode.markdown.updateContent'));
		// The scripts render async and grow the layout after the anchor scroll
		// above, so hold the position until they settle.
		keepAnchor(anchorLine, oldView);
	}

	function setEmpty() {
		cancelAnchorGuard();
		previewEl.innerHTML = '';
		previewEl.hidden = true;
		emptyEl.hidden = false;
		docNameEl.textContent = '';
	}

	window.addEventListener('message', (event) => {
		const message = event.data;
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
			case 'scrollToLine':
				scrollToLine(Number(message.line) || 0);
				break;
		}
	});

	previewEl.addEventListener('click', (e) => {
		if (e.defaultPrevented) {
			return;
		}
		const anchor = e.target.closest('a[href]');
		if (!anchor) {
			return;
		}
		const href = anchor.getAttribute('data-href') || anchor.getAttribute('href') || '';
		if (href.startsWith('#')) {
			const target = document.getElementById(href.slice(1));
			if (target) {
				e.preventDefault();
				target.scrollIntoView({ block: 'start' });
			}
			return;
		}
		if (href) {
			e.preventDefault();
			vscode.postMessage({ type: 'openLink', href });
		}
	});

	toolbar.addEventListener('click', (e) => {
		const button = e.target.closest('.toolbar-button');
		if (!button) {
			return;
		}
		vscode.postMessage({ type: 'command', id: button.dataset.command });
	});

	window.addEventListener('scroll', () => {
		if (programmaticScroll) {
			programmaticScroll = false;
		} else if (anchorGuard) {
			cancelAnchorGuard();
		}
		throttle(() => {
			const line = topmostVisibleLine();
			if (line >= 0 && line !== lastScrollLine) {
				lastScrollLine = line;
				vscode.postMessage({ type: 'scrollLine', line });
			}
		}, 120);
	}, { passive: true });
})();

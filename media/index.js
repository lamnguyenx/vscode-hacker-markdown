(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const toolbar = document.querySelector('.toolbar');
	const docNameEl = toolbar.querySelector('.doc-name');
	const previewEl = document.getElementById('preview');
	const emptyEl = document.getElementById('empty');

	let scrollThrottleTimer = undefined;
	let lastScrollLine = -1;

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

	function scrollToLine(line) {
		const els = dataLineElements();
		let target = null;
		let targetGap = Infinity;
		for (const el of els) {
			const l = Number(el.dataset.line) || 0;
			if (l === line) {
				target = el;
				break;
			}
			const gap = l - line;
			if (gap > 0 && gap < targetGap) {
				targetGap = gap;
				target = el;
			}
		}
		if (!target && els.length) {
			target = els[els.length - 1];
		}
		if (target) {
			target.scrollIntoView({ block: 'nearest' });
		}
	}

	function render(html) {
		// Keep the reading position anchored across re-renders: remember the
		// topmost visible line before swapping the DOM, then restore it.
		const anchorLine = topmostVisibleLine();
		previewEl.innerHTML = html;
		previewEl.hidden = false;
		emptyEl.hidden = true;
		if (anchorLine >= 0) {
			scrollToLine(anchorLine);
		}
		// Notify contributed preview scripts (e.g. the mermaid renderer) that
		// the document content changed, like the built-in preview does.
		window.dispatchEvent(new CustomEvent('vscode.markdown.updateContent'));
	}

	function setEmpty() {
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
		throttle(() => {
			const line = topmostVisibleLine();
			if (line >= 0 && line !== lastScrollLine) {
				lastScrollLine = line;
				vscode.postMessage({ type: 'scrollLine', line });
			}
		}, 120);
	}, { passive: true });
})();

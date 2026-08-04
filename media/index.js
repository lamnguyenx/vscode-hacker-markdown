(function () {
	'use strict';


	const vscode = acquireVsCodeApi();

	// The page may load after the host already pushed its state (webview
	// creation races the page load), so ask the host to re-push on load.
	vscode.postMessage({ type: 'ready' });

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
			scrollToLine(anchorLine);
		}
		// Re-frame the fragment's block-level imgs/svgs (plantuml, ...) and
		// restore their pan/zoom state.
		scanFrames();
		window.dispatchEvent(new CustomEvent('vscode.markdown.updateContent'));
		// The scripts render async and grow the layout after the anchor scroll
		// above, so hold the position until they settle.
		keepAnchor(anchorLine, oldView);
	}

	function setEmpty() {
		cancelAnchorGuard();
		disposeFrames();
		previewEl.innerHTML = '';
		previewEl.hidden = true;
		emptyEl.hidden = false;
		docNameEl.textContent = '';
	}

	// --- stale-diagram keepers ----------------------------------------------

	/**
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
	function snapshotStaleBlocks() {
		const out = [];
		let lineCount = 0;
		let gapOrder = 0;
		for (const child of previewEl.children) {
			if (child.hasAttribute('data-line')) {
				lineCount++;
				gapOrder = 0;
			} else if (child.tagName === 'IMG' || child.querySelector('svg, img')) {
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

	function newGapBlocks() {
		const out = [];
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

	function keepStaleBlocks(stale) {
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
				keepStaleImg(s.el, target.el);
			} else {
				holdPlaceholderHeight(s.el, target.el, s.height);
			}
		}
	}

	function keepStaleImg(oldImg, newImg) {
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

	function holdPlaceholderHeight(oldEl, newEl, height) {
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

	// --- pan/zoom frames for diagrams and images ----------------------------
	//
	// The built-in mermaid extension frames its own diagrams
	// (.mermaid-wrapper). Everything else that renders as a bare block-level
	// <img> or <svg> (plantuml, other preview renderers, plain images) gets a
	// frame here: an overflow-hidden wrapper whose inner content is moved with
	// `transform: translate() scale()` (origin 0 0), mirroring the mermaid
	// frame's interaction model. Alt is the "navigate this diagram" modifier,
	// so plain wheel scrolling and link clicks keep working unchanged; the
	// auto-hidden toolbar adds pan mode, zoom in/out and reset. Pan/zoom
	// state survives re-renders, keyed by the media content (the img src —
	// plantuml URLs encode the diagram source — or the svg markup), like the
	// mermaid frame's content-hash keys.

	const FRAME_MIN_SCALE = 0.5;
	const FRAME_MAX_SCALE = 10;
	const FRAME_ZOOM_FACTOR = 0.002;
	const FRAME_STATE_TTL_MS = 5000;

	const svgFrameMove = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M8 0L5 3h2v3H5v2H2V6L0 8l2 2V8h3v2h2v3H5l3 3 3-3H9V10h2V8h3v2l2-2-2-2v2h-3V6H9V3h2L8 0z"/></svg>`;
	const svgFrameZoomIn = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M6.5 1a5.5 5.5 0 1 0 3.32 9.85l3.42 3.42 1.06-1.06-3.42-3.42A5.5 5.5 0 0 0 6.5 1zm0 1.9a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2zM5.6 4.8v1.3H4.3v1.3h1.3v1.3h1.3V7.4h1.3V6.1H6.9V4.8z"/></svg>`;
	const svgFrameZoomOut = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M6.5 1a5.5 5.5 0 1 0 3.32 9.85l3.42 3.42 1.06-1.06-3.42-3.42A5.5 5.5 0 0 0 6.5 1zm0 1.9a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2zM4.3 6.1h4.4v1.3H4.3z"/></svg>`;
	const svgFrameReset = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="M3 1h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2zm1 3h8v8H4V4z"/></svg>`;

	// content key -> { scale, tx, ty, interacted, lastSeen }
	const frameStates = new Map();
	let frameScanTimer = undefined;

	function hashString(value) {
		let hash = 0;
		for (let i = 0; i < value.length; i++) {
			hash = ((hash << 5) - hash) + value.charCodeAt(i);
			hash = hash & hash;
		}
		return (hash >>> 0).toString(36);
	}

	function frameKey(el) {
		if (el.tagName === 'IMG') {
			return 'img:' + (el.getAttribute('src') || '');
		}
		if (el.tagName === 'SVG') {
			return 'svg:' + hashString(el.outerHTML || '');
		}
		return null;
	}

	/**
	 * A block-level img/svg that is not already framed, not part of a
	 * stale-render keeper, and not inline prose.
	 */
	function isFrameable(el) {
		if (el.tagName !== 'IMG' && el.tagName !== 'SVG') {
			return false;
		}
		if (el.closest('.hmk-frame, .mermaid-wrapper, .hmk-stale, .hmk-stale-holder, a')) {
			return false;
		}
		const parent = el.parentElement;
		if (!parent) {
			return false;
		}
		// Inline images (icons inside prose) must stay in flow. Inside a
		// phrasing container (p/span/...), any sibling text or element means
		// inline prose. In a block container (the preview body, td, li, ...)
		// only text beside the image does: block elements like H2/H3 are
		// separate blocks, so block-level imgs (plantuml output is a direct
		// child of the preview body) are still frameable.
		const isPhrasingParent = PHRASING_TAGS.has(parent.tagName);
		for (const node of parent.childNodes) {
			if (node === el) {
				continue;
			}
			if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
				return false;
			}
			if (isPhrasingParent && node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'BR') {
				return false;
			}
		}
		return true;
	}

	// Containers that can hold inline content: an image in one of these with
	// any other sibling is inline prose.
	const PHRASING_TAGS = new Set([
		'P', 'SPAN', 'EM', 'STRONG', 'A', 'CODE', 'SMALL', 'SUB', 'SUP', 'B', 'I',
		'U', 'S', 'MARK', 'KBD', 'Q', 'CITE', 'ABBR', 'DFN', 'LABEL', 'BUTTON',
		'TIME', 'VAR', 'DEL', 'INS', 'SAMP', 'DATA', 'BDO', 'BDI', 'TT'
	]);

	function createFrame(el, state) {
		const frame = document.createElement('div');
		frame.className = 'hmk-frame';
		frame.tabIndex = 0;

		const content = document.createElement('div');
		content.className = 'hmk-frame-content';

		el.replaceWith(frame);
		content.appendChild(el);
		frame.appendChild(content);

		if (el.tagName === 'IMG') {
			// Without this, Alt+drag would start a native image drag instead
			// of panning (mousedown preventDefault only stops dragstart from
			// events we already claim as pan).
			el.draggable = false;
		}

		const s = {
			scale: state?.scale ?? 1,
			tx: state?.tx ?? 0,
			ty: state?.ty ?? 0,
			interacted: !!state?.interacted,
			panMode: false,
			panning: false,
			dragged: false,
			startX: 0,
			startY: 0,
			controller: new AbortController()
		};
		frame.__hmk = s;

		setupFrameEvents(frame);
		frame.appendChild(buildFrameControls(frame));
		applyFrameTransform(frame);
		return frame;
	}

	function setupFrameEvents(frame) {
		const s = frame.__hmk;
		const signal = s.controller.signal;

		frame.addEventListener('mousedown', (e) => {
			if (e.button !== 0 || (!s.panMode && !e.altKey)) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			s.panning = true;
			s.dragged = false;
			s.startX = e.clientX - s.tx;
			s.startY = e.clientY - s.ty;
			frame.style.cursor = 'grabbing';
		}, { signal });

		document.addEventListener('mousemove', (e) => {
			if (!s.panning) {
				return;
			}
			if (e.buttons === 0) {
				endFramePan(frame);
				return;
			}
			const dx = e.clientX - s.startX - s.tx;
			const dy = e.clientY - s.startY - s.ty;
			if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
				s.dragged = true;
			}
			s.tx = e.clientX - s.startX;
			s.ty = e.clientY - s.startY;
			applyFrameTransform(frame);
		}, { signal });

		document.addEventListener('mouseup', () => endFramePan(frame), { signal });

		frame.addEventListener('mousemove', (e) => {
			if (!s.panning) {
				frame.style.cursor = (s.panMode || e.altKey) ? 'grab' : 'default';
			}
		}, { signal });

		frame.addEventListener('click', (e) => {
			if (!e.altKey || s.dragged) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const rect = frame.getBoundingClientRect();
			zoomFrameAt(frame, e.shiftKey ? 0.8 : 1.25, e.clientX - rect.left, e.clientY - rect.top);
		}, { signal });

		frame.addEventListener('wheel', (e) => {
			const pinch = e.ctrlKey;
			if (!pinch && !e.altKey) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const rect = frame.getBoundingClientRect();
			const delta = -e.deltaY * FRAME_ZOOM_FACTOR * (pinch ? 10 : 1);
			zoomFrameAt(frame, 1 + delta, e.clientX - rect.left, e.clientY - rect.top);
		}, { passive: false, signal });
	}

	function buildFrameControls(frame) {
		const s = frame.__hmk;
		const controls = document.createElement('div');
		controls.className = 'hmk-frame-controls';
		controls.innerHTML =
			`<button class="hmk-pan-btn" title="Toggle Pan Mode" aria-label="Toggle Pan Mode" aria-pressed="false">${svgFrameMove}</button>` +
			`<button class="hmk-zoom-out-btn" title="Zoom Out" aria-label="Zoom Out">${svgFrameZoomOut}</button>` +
			`<button class="hmk-zoom-in-btn" title="Zoom In" aria-label="Zoom In">${svgFrameZoomIn}</button>` +
			`<button class="hmk-zoom-reset-btn" title="Reset Zoom" aria-label="Reset Zoom">${svgFrameReset}</button>`;

		controls.querySelector('.hmk-pan-btn').addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			s.panMode = !s.panMode;
			e.currentTarget.classList.toggle('active', s.panMode);
			e.currentTarget.setAttribute('aria-pressed', String(s.panMode));
			frame.style.cursor = s.panMode ? 'grab' : 'default';
		});

		controls.querySelector('.hmk-zoom-in-btn').addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const rect = frame.getBoundingClientRect();
			zoomFrameAt(frame, 1.25, rect.width / 2, rect.height / 2);
		});

		controls.querySelector('.hmk-zoom-out-btn').addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const rect = frame.getBoundingClientRect();
			zoomFrameAt(frame, 0.8, rect.width / 2, rect.height / 2);
		});

		controls.querySelector('.hmk-zoom-reset-btn').addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			s.scale = 1;
			s.tx = 0;
			s.ty = 0;
			s.interacted = false;
			s.panMode = false;
			const panBtn = e.currentTarget.parentElement.querySelector('.hmk-pan-btn');
			panBtn.classList.remove('active');
			panBtn.setAttribute('aria-pressed', 'false');
			applyFrameTransform(frame);
		});

		return controls;
	}

	function endFramePan(frame) {
		const s = frame.__hmk;
		if (!s.panning) {
			return;
		}
		s.panning = false;
		frame.style.cursor = s.panMode ? 'grab' : 'default';
		s.interacted = true;
	}

	function zoomFrameAt(frame, factor, x, y) {
		const s = frame.__hmk;
		const newScale = Math.min(FRAME_MAX_SCALE, Math.max(FRAME_MIN_SCALE, s.scale * factor));
		const scaleFactor = newScale / s.scale;
		s.tx = x - (x - s.tx) * scaleFactor;
		s.ty = y - (y - s.ty) * scaleFactor;
		s.scale = newScale;
		s.interacted = true;
		applyFrameTransform(frame);
	}

	function applyFrameTransform(frame) {
		const s = frame.__hmk;
		frame.querySelector(':scope > .hmk-frame-content').style.transform =
			`translate(${s.tx}px, ${s.ty}px) scale(${s.scale})`;
	}

	/**
	 * Wraps unframed block-level imgs/svgs in pan/zoom frames. Also evicts
	 * saved states for content absent for a while, so zoom never resurrects
	 * for diagrams that were removed from the document.
	 */
	function scanFrames() {
		const now = Date.now();
		for (const [key, state] of frameStates) {
			if (now - state.lastSeen > FRAME_STATE_TTL_MS) {
				frameStates.delete(key);
			}
		}
		const seen = new Set();
		for (const el of Array.from(previewEl.querySelectorAll('img, svg'))) {
			if (!isFrameable(el)) {
				continue;
			}
			const key = frameKey(el);
			if (!key) {
				continue;
			}
			seen.add(key);
			createFrame(el, frameStates.get(key));
		}
		for (const key of seen) {
			const state = frameStates.get(key);
			if (state) {
				state.lastSeen = now;
			} else {
				frameStates.set(key, { scale: 1, tx: 0, ty: 0, interacted: false, lastSeen: now });
			}
		}
	}

	function scheduleFrameScan() {
		if (frameScanTimer) {
			return;
		}
		frameScanTimer = setTimeout(() => {
			frameScanTimer = undefined;
			scanFrames();
		}, 150);
	}

	/**
	 * Persists each live frame's pan/zoom state under its content key and
	 * refreshes lastSeen, so the next render can restore it.
	 */
	function snapshotFrameStates() {
		for (const frame of previewEl.querySelectorAll('.hmk-frame')) {
			const content = frame.querySelector(':scope > .hmk-frame-content');
			const el = content && content.firstElementChild;
			if (!el) {
				continue;
			}
			const key = frameKey(el);
			if (!key) {
				continue;
			}
			const s = frame.__hmk;
			frameStates.set(key, {
				scale: s.scale,
				tx: s.tx,
				ty: s.ty,
				interacted: s.interacted,
				lastSeen: Date.now()
			});
		}
	}

	function disposeFrames() {
		for (const frame of previewEl.querySelectorAll('.hmk-frame')) {
			frame.__hmk?.controller.abort();
		}
	}

	/** Removes the frame wrappers (before a DOM swap), releasing their listeners. */
	function unwrapFrames() {
		for (const frame of Array.from(previewEl.querySelectorAll('.hmk-frame'))) {
			frame.__hmk?.controller.abort();
			const content = frame.querySelector(':scope > .hmk-frame-content');
			const el = content && content.firstElementChild;
			if (el) {
				frame.replaceWith(el);
			} else {
				frame.remove();
			}
		}
	}

	// Contributed preview scripts replace their placeholders asynchronously
	// after each content update, so re-scan for late-rendered svgs.
	new MutationObserver(scheduleFrameScan).observe(previewEl, { childList: true, subtree: true });

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

import { previewEl } from './dom';

/**
 * Pan/zoom frames for diagrams and images.
 *
 * The built-in mermaid extension frames its own diagrams
 * (.mermaid-wrapper). Everything else that renders as a bare block-level
 * <img> or <svg> (plantuml, other preview renderers, plain images) gets a
 * frame here: an overflow-hidden wrapper whose inner content is moved with
 * `transform: translate() scale()` (origin 0 0), mirroring the mermaid
 * frame's interaction model. Alt is the "navigate this diagram" modifier,
 * so plain wheel scrolling and link clicks keep working unchanged; the
 * auto-hiding toolbar adds pan mode, zoom in/out and reset. Pan/zoom
 * state survives re-renders, keyed by the media content (the img src —
 * plantuml URLs encode the diagram source — or the svg markup), like the
 * mermaid frame's content-hash keys.
 */

const FRAME_MIN_SCALE = 0.5;
const FRAME_MAX_SCALE = 10;
const FRAME_ZOOM_FACTOR = 0.002;
const FRAME_STATE_TTL_MS = 5000;

const svgFrameMove = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M8 0L5 3h2v3H5v2H2V6L0 8l2 2V8h3v2h2v3H5l3 3 3-3H9V10h2V8h3v2l2-2-2-2v2h-3V6H9V3h2L8 0z"/></svg>`;
const svgFrameZoomIn = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M6.5 1a5.5 5.5 0 1 0 3.32 9.85l3.42 3.42 1.06-1.06-3.42-3.42A5.5 5.5 0 0 0 6.5 1zm0 1.9a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2zM5.6 4.8v1.3H4.3v1.3h1.3v1.3h1.3V7.4h1.3V6.1H6.9V4.8z"/></svg>`;
const svgFrameZoomOut = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M6.5 1a5.5 5.5 0 1 0 3.32 9.85l3.42 3.42 1.06-1.06-3.42-3.42A5.5 5.5 0 0 0 6.5 1zm0 1.9a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2zM4.3 6.1h4.4v1.3H4.3z"/></svg>`;
const svgFrameReset = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="M3 1h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2zm1 3h8v8H4V4z"/></svg>`;

interface FrameState {
	scale: number;
	tx: number;
	ty: number;
	interacted: boolean;
	lastSeen: number;
}

interface FrameRuntime {
	scale: number;
	tx: number;
	ty: number;
	interacted: boolean;
	panMode: boolean;
	panning: boolean;
	dragged: boolean;
	startX: number;
	startY: number;
	controller: AbortController;
}

// content key -> persisted pan/zoom state (survives re-renders)
const frameStates = new Map<string, FrameState>();
// frame element -> live runtime (replaces the old `frame.__hmk` property)
const frameRuntime = new WeakMap<HTMLElement, FrameRuntime>();

let frameScanTimer: number | undefined;

function getRuntime(frame: HTMLElement): FrameRuntime {
	return frameRuntime.get(frame)!;
}

function hashString(value: string): string {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = ((hash << 5) - hash) + value.charCodeAt(i);
		hash = hash & hash;
	}
	return (hash >>> 0).toString(36);
}

function frameKey(el: HTMLElement): string | null {
	const tag = el.tagName.toUpperCase();
	if (tag === 'IMG') {
		return 'img:' + (el.getAttribute('src') || '');
	}
	if (tag === 'SVG') {
		return 'svg:' + hashString(el.outerHTML || '');
	}
	return null;
}

// Containers that can hold inline content: an image in one of these with
// any other sibling is inline prose.
const PHRASING_TAGS = new Set([
	'P', 'SPAN', 'EM', 'STRONG', 'A', 'CODE', 'SMALL', 'SUB', 'SUP', 'B', 'I',
	'U', 'S', 'MARK', 'KBD', 'Q', 'CITE', 'ABBR', 'DFN', 'LABEL', 'BUTTON',
	'TIME', 'VAR', 'DEL', 'INS', 'SAMP', 'DATA', 'BDO', 'BDI', 'TT'
]);

/**
 * A block-level img/svg that is not already framed, not part of a
 * stale-render keeper, and not inline prose.
 */
function isFrameable(el: HTMLElement): boolean {
	// SVG elements report their tag name lowercase (`'svg'`), HTML elements
	// uppercase — normalize so the inlined PlantUML `<svg>` is framed too.
	const tag = el.tagName.toUpperCase();
	if (tag !== 'IMG' && tag !== 'SVG') {
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
		if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()) {
			return false;
		}
		if (isPhrasingParent && node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName !== 'BR') {
			return false;
		}
	}
	return true;
}

function createFrame(el: HTMLElement, state: FrameState | undefined): void {
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
		(el as HTMLImageElement).draggable = false;
	}

	const s: FrameRuntime = {
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
	frameRuntime.set(frame, s);

	setupFrameEvents(frame);
	frame.appendChild(buildFrameControls(frame));
	applyFrameTransform(frame);
}

function setupFrameEvents(frame: HTMLElement): void {
	const s = getRuntime(frame);
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
			// A pan/zoom drag-release fires a click on the frame: stop it here
			// so it never reaches the preview click handler (click-to-source).
			if (s.dragged) {
				e.stopPropagation();
			}
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

function buildFrameControls(frame: HTMLElement): HTMLElement {
	const s = getRuntime(frame);
	const controls = document.createElement('div');
	controls.className = 'hmk-frame-controls';
	controls.innerHTML =
		`<button class="hmk-pan-btn" title="Toggle Pan Mode" aria-label="Toggle Pan Mode" aria-pressed="false">${svgFrameMove}</button>` +
		`<button class="hmk-zoom-out-btn" title="Zoom Out" aria-label="Zoom Out">${svgFrameZoomOut}</button>` +
		`<button class="hmk-zoom-in-btn" title="Zoom In" aria-label="Zoom In">${svgFrameZoomIn}</button>` +
		`<button class="hmk-zoom-reset-btn" title="Reset Zoom" aria-label="Reset Zoom">${svgFrameReset}</button>`;

	controls.querySelector('.hmk-pan-btn')!.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		s.panMode = !s.panMode;
		(e.currentTarget as HTMLElement).classList.toggle('active', s.panMode);
		(e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(s.panMode));
		frame.style.cursor = s.panMode ? 'grab' : 'default';
	});

	controls.querySelector('.hmk-zoom-in-btn')!.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		const rect = frame.getBoundingClientRect();
		zoomFrameAt(frame, 1.25, rect.width / 2, rect.height / 2);
	});

	controls.querySelector('.hmk-zoom-out-btn')!.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		const rect = frame.getBoundingClientRect();
		zoomFrameAt(frame, 0.8, rect.width / 2, rect.height / 2);
	});

	controls.querySelector('.hmk-zoom-reset-btn')!.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		s.scale = 1;
		s.tx = 0;
		s.ty = 0;
		s.interacted = false;
		s.panMode = false;
		const panBtn = (e.currentTarget as HTMLElement).parentElement!.querySelector('.hmk-pan-btn')!;
		panBtn.classList.remove('active');
		panBtn.setAttribute('aria-pressed', 'false');
		applyFrameTransform(frame);
	});

	return controls;
}

function endFramePan(frame: HTMLElement): void {
	const s = getRuntime(frame);
	if (!s.panning) {
		return;
	}
	s.panning = false;
	frame.style.cursor = s.panMode ? 'grab' : 'default';
	s.interacted = true;
}

function zoomFrameAt(frame: HTMLElement, factor: number, x: number, y: number): void {
	const s = getRuntime(frame);
	const newScale = Math.min(FRAME_MAX_SCALE, Math.max(FRAME_MIN_SCALE, s.scale * factor));
	const scaleFactor = newScale / s.scale;
	s.tx = x - (x - s.tx) * scaleFactor;
	s.ty = y - (y - s.ty) * scaleFactor;
	s.scale = newScale;
	s.interacted = true;
	applyFrameTransform(frame);
}

function applyFrameTransform(frame: HTMLElement): void {
	const s = getRuntime(frame);
	frame.querySelector<HTMLElement>(':scope > .hmk-frame-content')!.style.transform =
		`translate(${s.tx}px, ${s.ty}px) scale(${s.scale})`;
}

/**
 * Wraps unframed block-level imgs/svgs in pan/zoom frames. Also evicts
 * saved states for content absent for a while, so zoom never resurrects
 * for diagrams that were removed from the document.
 */
export function scanFrames(): void {
	const now = Date.now();
	for (const [key, state] of frameStates) {
		if (now - state.lastSeen > FRAME_STATE_TTL_MS) {
			frameStates.delete(key);
		}
	}
	const seen = new Set<string>();
	for (const el of Array.from(previewEl.querySelectorAll<HTMLElement>('img, svg'))) {
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

export function scheduleFrameScan(): void {
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
export function snapshotFrameStates(): void {
	for (const frame of previewEl.querySelectorAll<HTMLElement>('.hmk-frame')) {
		const content = frame.querySelector<HTMLElement>(':scope > .hmk-frame-content');
		const el = content?.firstElementChild as HTMLElement | undefined;
		if (!el) {
			continue;
		}
		const key = frameKey(el);
		if (!key) {
			continue;
		}
		const s = getRuntime(frame);
		frameStates.set(key, {
			scale: s.scale,
			tx: s.tx,
			ty: s.ty,
			interacted: s.interacted,
			lastSeen: Date.now()
		});
	}
}

export function disposeFrames(): void {
	for (const frame of previewEl.querySelectorAll<HTMLElement>('.hmk-frame')) {
		getRuntime(frame).controller.abort();
	}
}

/** Removes the frame wrappers (before a DOM swap), releasing their listeners. */
export function unwrapFrames(): void {
	for (const frame of Array.from(previewEl.querySelectorAll<HTMLElement>('.hmk-frame'))) {
		getRuntime(frame).controller.abort();
		const content = frame.querySelector<HTMLElement>(':scope > .hmk-frame-content');
		const el = content?.firstElementChild as HTMLElement | undefined;
		if (el) {
			frame.replaceWith(el);
		} else {
			frame.remove();
		}
	}
}

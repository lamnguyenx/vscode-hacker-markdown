import { toolbar, post } from './dom';
import type { MediaState } from './types';

/**
 * Media toolbar controls (see `PreviewHost.getMediaControls`):
 * - the invert / tables dropdowns (`.hmk-menu[data-menu-key]`),
 * - the reading-column-width input + reset button,
 * - the zoom stepper group ([−] [%] [+]).
 *
 * The extension host owns the persisted state (`hackerMarkdown.media.*`
 * settings) and broadcasts it via `mediaState`; these handlers are the
 * webview half of the controls. The dropdown item clicks post `setMedia`;
 * reset buttons and the zoom‑% button go through the generic `command`
 * message; the zoom −/+ buttons compute the step webview-side.
 */

const CSS_LENGTH_REG = /^\d*\.?\d+(?:px|vw|vh|%|rem|em|ch|ex|cm|mm|in|pt|pc|q)$/i;

interface LengthInputConfig {
	readonly cssVar: string;
	readonly messageKey: 'columnWidth';
	readonly fallbackValue: string;
	readonly allowEmpty: boolean;
}

const LENGTH_INPUTS: Record<string, LengthInputConfig> = {
	columnWidth: { cssVar: '--hmk-column-width', messageKey: 'columnWidth', fallbackValue: '100%', allowEmpty: false },
};

const persistedValues = new Map<string, string>();

// --- zoom state ---
let persistedZoom = 100;

function applyZoom(n: number): void {
	document.documentElement.style.setProperty('--hmk-zoom', String(n / 100));
	const readout = toolbar.querySelector<HTMLElement>('.hmk-zoom-value');
	if (readout) {
		readout.textContent = `${n}%`;
		readout.setAttribute('aria-label', `Zoom level: ${n}%`);
	}
}

function stepZoom(dir: 1 | -1): void {
	// Snap to nearest 5, then step
	const raw = document.documentElement.style.getPropertyValue('--hmk-zoom');
	const current = raw ? Math.round(Number(raw) * 100) : persistedZoom;
	const next = Math.max(50, Math.min(200, Math.round(current / 5) * 5 + dir * 5));
	persistedZoom = next;
	applyZoom(next);
	post({ type: 'setMedia', key: 'zoom', value: String(next) });
}

function resetZoom(): void {
	persistedZoom = 100;
	applyZoom(100);
	post({ type: 'setMedia', key: 'zoom', value: '100' });
}

function initZoomControls(): void {
	toolbar.querySelectorAll<HTMLElement>('[data-zoom-step]').forEach((btn) => {
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			stepZoom(btn.getAttribute('data-zoom-step') === '+1' ? 1 : -1);
		});
	});
}

export function initMediaControls(): void {
	initMenus();
}

function menuKey(menu: HTMLElement): string {
	return menu.dataset.menuKey ?? '';
}

function closeMenus(except?: HTMLElement): void {
	for (const menu of Array.from(toolbar.querySelectorAll<HTMLElement>('.hmk-menu'))) {
		if (menu === except) {
			continue;
		}
		const panel = menu.querySelector<HTMLElement>('.hmk-menu-panel');
		const trigger = menu.querySelector<HTMLElement>('.toolbar-button');
		if (panel && !panel.hidden) {
			panel.hidden = true;
			trigger?.setAttribute('aria-expanded', 'false');
		}
	}
}

function initMenus(): void {
	for (const menu of Array.from(toolbar.querySelectorAll<HTMLElement>('.hmk-menu'))) {
		const key = menuKey(menu);
		const trigger = menu.querySelector<HTMLElement>('.toolbar-button');
		const panel = menu.querySelector<HTMLElement>('.hmk-menu-panel');
		if (!trigger || !panel) {
			continue;
		}
		trigger.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const open = panel.hidden;
			closeMenus(menu);
			panel.hidden = !open;
			trigger.setAttribute('aria-expanded', String(open));
		});
		for (const item of Array.from(panel.querySelectorAll<HTMLElement>('.hmk-menu-item'))) {
			item.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				const value = item.dataset.value ?? '';
				if (value) {
					post({ type: 'setMedia', key: key as 'invert' | 'tables', value });
				}
				closeMenus();
			});
		}
	}

	// Outside click / Esc closes every open menu.
	document.addEventListener('click', (e) => {
		const target = e.target as Element | null;
		if (!target?.closest('.hmk-menu')) {
			closeMenus();
		}
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			const open = Array.from(toolbar.querySelectorAll<HTMLElement>('.hmk-menu-panel'))
				.find((panel) => !panel.hidden);
			if (open) {
				closeMenus();
				(open.parentElement?.querySelector<HTMLElement>('.toolbar-button'))?.focus();
			}
			return;
		}
		// Zoom shortcuts — Ctrl/Cmd + =-/0 (preview-focused; preventDefault so
		// the browser/VS Code window-zoom doesn't double-fire).
		if (e.ctrlKey || e.metaKey) {
			if (e.key === '=' || e.key === '+' || (e.shiftKey && (e.key === '=' || e.key === '+'))) {
				e.preventDefault();
				e.stopPropagation();
				stepZoom(1);
			} else if (e.key === '-' || e.key === '\u005F') {
				e.preventDefault();
				e.stopPropagation();
				stepZoom(-1);
			} else if (e.key === '0') {
				e.preventDefault();
				e.stopPropagation();
				resetZoom();
			}
		}
	});

	initLengthControls();
	initZoomControls();
}

function setLengthProperty(cssVar: string, value: string): void {
	if (value) {
		document.documentElement.style.setProperty(cssVar, value);
	} else {
		document.documentElement.style.removeProperty(cssVar);
	}
}

function initLengthControls(): void {
	for (const input of Array.from(toolbar.querySelectorAll<HTMLInputElement>('[data-media-input]'))) {
		const name = input.dataset.mediaInput ?? '';
		const cfg = LENGTH_INPUTS[name];
		if (!cfg) {
			continue;
		}

		persistedValues.set(name, input.value);

		input.addEventListener('input', () => {
			const value = input.value.trim();
			if (CSS_LENGTH_REG.test(value)) {
				setLengthProperty(cfg.cssVar, value);
			}
		});

		let suppressChange = false;
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				input.blur();
			} else if (e.key === 'Escape') {
				suppressChange = true;
				input.value = persistedValues.get(name) ?? cfg.fallbackValue;
				input.blur();
			}
		});
		input.addEventListener('change', () => {
			if (suppressChange) {
				suppressChange = false;
				return;
			}
			const value = input.value.trim();
			if (CSS_LENGTH_REG.test(value)) {
				persistedValues.set(name, value);
				setLengthProperty(cfg.cssVar, value);
				post({ type: 'setMedia', key: cfg.messageKey, value });
			} else if (cfg.allowEmpty && value === '') {
				persistedValues.set(name, '');
				setLengthProperty(cfg.cssVar, '');
				post({ type: 'setMedia', key: cfg.messageKey, value: '' });
			} else {
				input.value = persistedValues.get(name) ?? cfg.fallbackValue;
			}
		});

		toolbar.querySelector<HTMLElement>(`[data-command="reset${name === 'columnWidth' ? 'Column' : 'FontSize'}"]`)?.addEventListener('click', () => {
			persistedValues.set(name, cfg.fallbackValue);
			setLengthProperty(cfg.cssVar, cfg.fallbackValue);
			input.value = cfg.fallbackValue;
		});
	}
}

/**
 * Applies the host-broadcast media state: body attributes for user styles,
 * the CSS custom properties and the control UI (titles, checked items, input
 * values). Inputs are not overwritten while focused so a broadcast cannot
 * clobber an in-progress edit.
 */
export function applyMediaState(state: MediaState): void {
	const body = document.body;
	body.dataset.invert = state.invert;
	body.dataset.tables = state.tables;
	persistedValues.set('columnWidth', state.columnWidth);
	if (CSS_LENGTH_REG.test(state.columnWidth)) {
		setLengthProperty('--hmk-column-width', state.columnWidth);
	}
	persistedZoom = state.zoom;
	applyZoom(state.zoom);

	for (const menu of Array.from(toolbar.querySelectorAll<HTMLElement>('.hmk-menu'))) {
		const key = menuKey(menu);
		const trigger = menu.querySelector<HTMLElement>('.toolbar-button');
		const current = key === 'invert' ? state.invert : key === 'tables' ? state.tables : undefined;
		if (current && trigger) {
			const title = key === 'invert' ? `Media invert: ${current}` : `Wide tables: ${current}`;
			trigger.title = title;
			trigger.setAttribute('aria-label', title);
		}
		for (const item of Array.from(menu.querySelectorAll<HTMLElement>('.hmk-menu-item'))) {
			item.setAttribute('aria-checked', String(item.dataset.value === current));
		}
	}

	for (const input of Array.from(toolbar.querySelectorAll<HTMLInputElement>('[data-media-input]'))) {
		if (document.activeElement === input) {
			continue;
		}
		if (input.dataset.mediaInput === 'columnWidth') {
			input.value = state.columnWidth;
		}
	}
}
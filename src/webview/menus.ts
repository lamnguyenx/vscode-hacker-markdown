import { toolbar, post } from './dom';
import type { MediaState } from './types';

/**
 * Media toolbar controls (see `PreviewHost.getMediaControls`):
 * - the invert / tables dropdowns (`.hmk-menu[data-menu-key]`),
 * - the reading-column-width input (`.toolbar-input`) + reset button.
 *
 * The extension host owns the persisted state (`hackerMarkdown.media.*`
 * settings) and broadcasts it via `mediaState`; these handlers are the
 * webview half of the controls. The dropdown item clicks post `setMedia`;
 * the reset button goes through the generic `command` message
 * (`resetColumn`).
 */

const CSS_LENGTH_REG = /^\d*\.?\d+(?:px|vw|vh|%|rem|em|ch|ex|cm|mm|in|pt|pc|q)$/i;

/** The last persisted column width (the fallback when an edit is invalid). */
let persistedColumnWidth = '100%';

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
		if (e.key !== 'Escape') {
			return;
		}
		const open = Array.from(toolbar.querySelectorAll<HTMLElement>('.hmk-menu-panel'))
			.find((panel) => !panel.hidden);
		if (open) {
			closeMenus();
			(open.parentElement?.querySelector<HTMLElement>('.toolbar-button'))?.focus();
		}
	});

	initColumnControl();
}

function setColumnWidth(value: string): void {
	document.documentElement.style.setProperty('--hmk-column-width', value);
}

function initColumnControl(): void {
	const input = toolbar.querySelector<HTMLInputElement>('.toolbar-input');
	if (!input) {
		return;
	}
	// Live: apply valid values instantly (no host roundtrip per keystroke).
	input.addEventListener('input', () => {
		const value = input.value.trim();
		if (CSS_LENGTH_REG.test(value)) {
			setColumnWidth(value);
		}
	});
	// Enter (via blur) / blur: persist when valid, otherwise revert.
	let suppressChange = false;
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			input.blur();
		} else if (e.key === 'Escape') {
			suppressChange = true;
			input.value = persistedColumnWidth;
			input.blur();
		}
	});
	input.addEventListener('change', () => {
		if (suppressChange) {
			suppressChange = false;
			return;
		}
		const value = input.value.trim();
		if (!CSS_LENGTH_REG.test(value)) {
			input.value = persistedColumnWidth;
			return;
		}
		persistedColumnWidth = value;
		setColumnWidth(value);
		post({ type: 'setMedia', key: 'columnWidth', value });
	});

	// The reset button applies 100% locally immediately (even while the input
	// is focused — the mediaState guard would otherwise skip a focused field).
	// The host persists the value via the command message.
	toolbar.querySelector<HTMLElement>('[data-command="resetColumn"]')?.addEventListener('click', () => {
		persistedColumnWidth = '100%';
		setColumnWidth('100%');
		input.value = '100%';
	});
}

/**
 * Applies the host-broadcast media state: body attributes for user styles,
 * the column-width custom property and the control UI (titles, checked
 * items, input value). The input is not overwritten while it is focused so
 * a broadcast cannot clobber an in-progress edit.
 */
export function applyMediaState(state: MediaState): void {
	const body = document.body;
	body.dataset.invert = state.invert;
	body.dataset.tables = state.tables;
	persistedColumnWidth = state.columnWidth;
	if (!CSS_LENGTH_REG.test(state.columnWidth)) {
		return;
	}
	setColumnWidth(state.columnWidth);

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

	const input = toolbar.querySelector<HTMLInputElement>('.toolbar-input');
	if (input && document.activeElement !== input) {
		input.value = state.columnWidth;
	}
}

export function initMediaControls(): void {
	initMenus();
}

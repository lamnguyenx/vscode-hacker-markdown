// CDP integration test for media toolbar dropdowns (invert, tables, column width).
//
// Verifies:
//   - Invert dropdown changes body[data-invert] and persists to settings.
//   - Tables dropdown changes body[data-tables].
//   - Column width input changes --hmk-column-width CSS var.
//   - Reset buttons restore defaults.
//
// Usage: bun tests/integration/media_controls_ix.ts [port]
import { connectPreview, evalUntil, sleep } from './cdp';

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const handle = await connectPreview(port);
	if (!handle) {
		console.error('NO_PREVIEW: run bun tests/integration/open_view.ts <port> first');
		process.exit(2);
	}

	await evalUntil(handle, `!!d.querySelector('#preview > *')`, 30000);

	const results: { name: string; ok: boolean }[] = [];
	const check = (name: string, ok: boolean, extra = '') => {
		results.push({ name, ok });
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
	};

	// Save the initial state so we can restore it at the end.
	const initialState = await handle.pEval(`(() => ({
		invert: d.body.dataset.invert,
		tables: d.body.dataset.tables,
		columnWidth: d.documentElement.style.getPropertyValue('--hmk-column-width'),
	}))()`);

	// Helper: open menu trigger, click item, wait for broadcast.
	const selectMenuItem = async (menuKey: string, value: string, timeoutMs = 5000): Promise<string | undefined> => {
		// Open the dropdown.
		await handle.pEval(`(() => {
			const trigger = d.querySelector('[data-menu-key="${menuKey}"] .toolbar-button[data-menu]');
			if (trigger) trigger.click();
		})()`);
		await sleep(200);
		// Click the item.
		await handle.pEval(`(() => {
			const items = [...d.querySelectorAll('[data-menu-key="${menuKey}"] .hmk-menu-item')];
			const item = items.find(i => i.dataset.value === ${JSON.stringify(value)});
			if (item) item.click();
		})()`);
		// Poll for the body attribute to reflect the change (config round-trip).
		const dataAttr = menuKey === 'invert' ? 'invert' : 'tables';
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const current = await handle.pEval(`d.body.dataset.${dataAttr}`);
			if (current === value) return current;
			await sleep(300);
		}
		return await handle.pEval(`d.body.dataset.${dataAttr}`);
	};

	// -----------------------------------------------------------------------
	// 1. Invert dropdown: set to "off"
	// -----------------------------------------------------------------------
	let invert = await selectMenuItem('invert', 'off');
	check('invert dropdown sets body[data-invert="off"]', invert === 'off', `got "${invert}"`);

	// Set to "light"
	invert = await selectMenuItem('invert', 'light');
	check('invert dropdown sets body[data-invert="light"]', invert === 'light', `got "${invert}"`);

	// -----------------------------------------------------------------------
	// 2. Tables dropdown: set to "pan"
	// -----------------------------------------------------------------------
	let tables = await selectMenuItem('tables', 'pan');
	check('tables dropdown sets body[data-tables="pan"]', tables === 'pan', `got "${tables}"`);

	// Set to "fit"
	tables = await selectMenuItem('tables', 'fit');
	check('tables dropdown sets body[data-tables="fit"]', tables === 'fit', `got "${tables}"`);

	// -----------------------------------------------------------------------
	// 3. Column width input
	// -----------------------------------------------------------------------
	await handle.pEval(`(() => {
		const input = d.querySelector('[data-media-input="columnWidth"]');
		if (input) {
			input.value = '700px';
			input.dispatchEvent(new Event('input'));
			input.dispatchEvent(new Event('change'));
		}
	})()`);
	await sleep(500);
	let colWidth = await handle.pEval(`d.documentElement.style.getPropertyValue('--hmk-column-width')`);
	check('column width input sets --hmk-column-width', colWidth === '700px', `got "${colWidth}"`);

	// -----------------------------------------------------------------------
	// 4. Reset column width button
	// -----------------------------------------------------------------------
	await handle.pEval(`(() => {
		const btn = d.querySelector('[data-command="resetColumn"]');
		if (btn) btn.click();
	})()`);
	await sleep(500);
	colWidth = await handle.pEval(`d.documentElement.style.getPropertyValue('--hmk-column-width')`);
	check('reset column width restores 100%', colWidth === '100%', `got "${colWidth}"`);

	// -----------------------------------------------------------------------
	// 5. Column width Escape reverts (type 800px via input only — no commit,
	// then Escape should revert to the previously committed value).
	// -----------------------------------------------------------------------
	// First commit 700px as the new baseline.
	await handle.pEval(`(() => {
		const input = d.querySelector('[data-media-input="columnWidth"]');
		if (!input) return;
		input.value = '700px';
		input.dispatchEvent(new Event('input'));
		input.dispatchEvent(new Event('change'));
	})()`);
	await sleep(300);
	// Wait for any pending mediaState broadcast to settle.
	await sleep(2000);
	// Now type 800px without committing (input only), then Escape.
	await handle.pEval(`(() => {
		const input = d.querySelector('[data-media-input="columnWidth"]');
		if (!input) return;
		input.focus();
		input.value = '800px';
		input.dispatchEvent(new Event('input'));
	})()`);
	await sleep(200);
	await handle.pEval(`(() => {
		const input = d.querySelector('[data-media-input="columnWidth"]');
		if (!input) return;
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	})()`);
	await sleep(300);
	const escapeInputValue = await handle.pEval(`(() => {
		const input = d.querySelector('[data-media-input="columnWidth"]');
		return input?.value || '';
	})()`);
	check('Escape in column width reverts input to previous committed value',
		escapeInputValue === '700px', `got "${escapeInputValue}"`);

	// -----------------------------------------------------------------------
	// Restore initial state
	// -----------------------------------------------------------------------
	await handle.pEval(`(() => {
		const invertItems = [...d.querySelectorAll('[data-menu-key="invert"] .hmk-menu-item')];
		const it = invertItems.find(i => i.dataset.value === ${JSON.stringify(initialState.invert)});
		if (it) it.click();
		const tableItems = [...d.querySelectorAll('[data-menu-key="tables"] .hmk-menu-item')];
		const tt = tableItems.find(i => i.dataset.value === ${JSON.stringify(initialState.tables)});
		if (tt) tt.click();
	})()`);
	await sleep(500);

	handle.close();
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });

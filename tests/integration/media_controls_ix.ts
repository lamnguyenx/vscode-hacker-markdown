// Integration test for media toolbar dropdowns (invert, tables, column width).
//
// Verifies:
//   - Invert dropdown changes body[data-invert] and persists to settings.
//   - Tables dropdown changes body[data-tables].
//   - Column width input changes --hmk-column-width CSS var.
//   - Reset buttons restore defaults.
//
// Uses REST API to set/restore config (deterministic, no UI click latency)
// and CDP to assert on webview DOM state. The column-width Escape test
// still uses in-webview DOM events because Escape is a webview-internal
// behavior (not a vscode command).
//
// Usage: bun tests/integration/media_controls_ix.ts [cdp-port]
import { connectPreview, evalUntil, sleep } from './cdp';
import { restEval } from './rest';
import { createSuite } from './test_utils';

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const handle = await connectPreview(port);
	if (!handle) {
		console.error('NO_PREVIEW: run bun tests/integration/open_view.ts <port> first');
		process.exit(2);
	}

	await evalUntil(handle, `!!d.querySelector('#preview > *')`, 30000);

	const { check, finish } = createSuite();

	// Save initial state so we can restore it at the end.
	const initialState = await handle.pEval(`(() => ({
		invert: d.body.dataset.invert,
		tables: d.body.dataset.tables,
		columnWidth: d.documentElement.style.getPropertyValue('--hmk-column-width'),
	}))()`);

	// Helper: set config via REST and wait for the webview broadcast.
	const setMedia = async (key: string, value: string): Promise<void> => {
		await restEval(`vscode.workspace.getConfiguration('hackerMarkdown').update('media.${key}', ${JSON.stringify(value)}, vscode.ConfigurationTarget.Global)`);
	};
	const pollAttr = async (attr: string, value: string, timeoutMs = 5000): Promise<string> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const current = await handle.pEval(`d.body.dataset.${attr}`);
			if (current === value) return current;
			await sleep(300);
		}
		return await handle.pEval(`d.body.dataset.${attr}`);
	};

	// -----------------------------------------------------------------------
	// 1. Invert: set to "off" then "light" via REST config
	// -----------------------------------------------------------------------
	await setMedia('invert', 'off');
	let invert = await pollAttr('invert', 'off');
	check('invert config sets body[data-invert="off"]', invert === 'off', `got "${invert}"`);

	await setMedia('invert', 'light');
	invert = await pollAttr('invert', 'light');
	check('invert config sets body[data-invert="light"]', invert === 'light', `got "${invert}"`);

	// -----------------------------------------------------------------------
	// 2. Tables: set to "pan" then "fit" via REST config
	// -----------------------------------------------------------------------
	await setMedia('tables', 'pan');
	let tables = await pollAttr('tables', 'pan');
	check('tables config sets body[data-tables="pan"]', tables === 'pan', `got "${tables}"`);

	await setMedia('tables', 'fit');
	tables = await pollAttr('tables', 'fit');
	check('tables config sets body[data-tables="fit"]', tables === 'fit', `got "${tables}"`);

	// -----------------------------------------------------------------------
	// 3. Column width input (in-webview: type + commit)
	// -----------------------------------------------------------------------
	await handle.pEval(`(() => {
		const input = d.querySelector('[data-media-input="columnWidth"]');
		if (input) { input.value = '700px'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change')); }
	})()`);
	await sleep(500);
	let colWidth = await handle.pEval(`d.documentElement.style.getPropertyValue('--hmk-column-width')`);
	check('column width input sets --hmk-column-width', colWidth === '700px', `got "${colWidth}"`);

	// -----------------------------------------------------------------------
	// 4. Reset column width button
	// -----------------------------------------------------------------------
	await handle.pEval(`(() => { const btn = d.querySelector('[data-command="resetColumn"]'); if (btn) btn.click(); })()`);
	await sleep(500);
	colWidth = await handle.pEval(`d.documentElement.style.getPropertyValue('--hmk-column-width')`);
	check('reset column width restores 100%', colWidth === '100%', `got "${colWidth}"`);

	// -----------------------------------------------------------------------
	// 5. Column width Escape reverts to previous committed value
	// -----------------------------------------------------------------------
	// Commit 700px as baseline.
	await handle.pEval(`(() => {
		const input = d.querySelector('[data-media-input="columnWidth"]');
		if (!input) return;
		input.value = '700px'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change'));
	})()`);
	await sleep(2000);
	// Type 800px without committing, then Escape.
	await handle.pEval(`(() => {
		const input = d.querySelector('[data-media-input="columnWidth"]');
		if (!input) return;
		input.focus(); input.value = '800px'; input.dispatchEvent(new Event('input'));
	})()`);
	await sleep(200);
	await handle.pEval(`(() => {
		const input = d.querySelector('[data-media-input="columnWidth"]');
		if (!input) return;
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	})()`);
	await sleep(300);
	const escapeInputValue = await handle.pEval(`(() => { const input = d.querySelector('[data-media-input="columnWidth"]'); return input?.value || ''; })()`);
	check('Escape in column width reverts input to previous committed value',
		escapeInputValue === '700px', `got "${escapeInputValue}"`);

	// -----------------------------------------------------------------------
	// Restore initial state via REST config
	// -----------------------------------------------------------------------
	await setMedia('invert', initialState.invert || 'auto');
	await setMedia('tables', initialState.tables || 'pan');
	await sleep(500);

	handle.close();
	finish();
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });

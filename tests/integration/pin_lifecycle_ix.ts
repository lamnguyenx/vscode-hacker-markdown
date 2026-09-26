// CDP integration test for pin/lock lifecycle.
//
// Verifies:
//   - Clicking the pin button freezes the preview on the current document.
//   - Switching to a different .md does NOT change the preview doc-name.
//   - Unpinning resumes following the active editor.
//
// Usage: bun tests/integration/pin_lifecycle_ix.ts [port]
import { connectPreview, evalUntil, getTargets, openCdpSession, sleep, type CdpSession } from './cdp';

async function openFileQuickOpen(page: CdpSession, filename: string): Promise<void> {
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', modifiers: 2 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', modifiers: 2 });
	await sleep(500);
	await page.send('Input.insertText', { text: filename });
	await sleep(600);
	const rect = await page.eval(`(() => {
		const rows = [...document.querySelectorAll('.quick-input-list .monaco-list-row')];
		const row = rows.find(r => (r.textContent || '').includes(${JSON.stringify(filename)}));
		if (!row) return null;
		const b = row.getBoundingClientRect();
		return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
	})()`);
	if (rect) {
		await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
		await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
	} else {
		await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
		await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
	}
	await sleep(1000);
}

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const handle = await connectPreview(port);
	if (!handle) {
		console.error('NO_PREVIEW: run bun tests/integration/open_view.ts <port> first');
		process.exit(2);
	}

	const targets = await getTargets(port);
	const pageTarget = targets.find((t) => t.type === 'page')!;
	const page = await openCdpSession(pageTarget.webSocketDebuggerUrl);

	// Ensure test.md is open first.
	await openFileQuickOpen(page, 'test.md');
	await sleep(1500);
	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'test.md'`, 20000);

	const results: { name: string; ok: boolean }[] = [];
	const check = (name: string, ok: boolean, extra = '') => {
		results.push({ name, ok });
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
	};

	// -----------------------------------------------------------------------
	// 1. Initial state — doc-name follows test.md
	// -----------------------------------------------------------------------
	const docName0 = await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent || ''`, 30000);
	check('initial doc-name is test.md', docName0 === 'test.md', `got "${docName0}"`);

	// -----------------------------------------------------------------------
	// 2. Click the pin button
	// -----------------------------------------------------------------------
	await handle.pEval(`(() => {
		const btn = d.querySelector('[data-command="togglePin"]');
		if (btn) btn.click();
		return !!btn;
	})()`);
	await sleep(500);

	const pinned = await handle.pEval(`(() => {
		const btn = d.querySelector('[data-command="togglePin"]');
		return {
			ariaPressed: btn?.getAttribute('aria-pressed'),
			bodyClass: d.body.classList.contains('hmk-pinned')
		};
	})()`);
	check('pin button shows pinned state', pinned.ariaPressed === 'true' && pinned.bodyClass === true,
		`aria=${pinned.ariaPressed} pinned=${pinned.bodyClass}`);

	// -----------------------------------------------------------------------
	// 3. Switch to sub.md — preview should NOT follow
	// -----------------------------------------------------------------------
	await openFileQuickOpen(page, 'sub.md');
	await sleep(1500);

	const docNamePinned = await handle.pEval(`d.querySelector('.toolbar .doc-name')?.textContent || ''`);
	check('preview stays pinned to test.md after editor switch', docNamePinned === 'test.md',
		`got "${docNamePinned}"`);

	// -----------------------------------------------------------------------
	// 4. Unpin — preview should follow active editor (sub.md)
	// -----------------------------------------------------------------------
	await handle.pEval(`(() => {
		const btn = d.querySelector('[data-command="togglePin"]');
		if (btn) btn.click();
		return !!btn;
	})()`);
	await sleep(1500);

	const docNameUnpinned = await handle.pEval(`d.querySelector('.toolbar .doc-name')?.textContent || ''`);
	check('preview follows sub.md after unpin', docNameUnpinned === 'sub.md',
		`got "${docNameUnpinned}"`);

	const unpinnedState = await handle.pEval(`(() => {
		const btn = d.querySelector('[data-command="togglePin"]');
		return btn?.getAttribute('aria-pressed');
	})()`);
	check('pin button shows unpinned state', unpinnedState === 'false');

	// Cleanup: re-open test.md
	await openFileQuickOpen(page, 'test.md');
	await sleep(1000);

	handle.close();
	page.close();
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });

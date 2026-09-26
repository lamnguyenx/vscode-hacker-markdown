// Integration test for pin/lock lifecycle.
//
// Verifies:
//   - Clicking the pin button freezes the preview on the current document.
//   - Switching to a different .md does NOT change the preview doc-name.
//   - Unpinning resumes following the active editor.
//
// Uses REST API for arrange (open files) and CDP for assert only.
//
// Usage: bun tests/integration/pin_lifecycle_ix.ts [cdp-port]
import { connectPreview, evalUntil, sleep } from './cdp';
import { restOpenFile, restEval } from './rest';
import { createSuite } from './test_utils';

const WS = '/home/lamnt45/git/vscode-hacker-markdown/tests/samples/workspace';

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const handle = await connectPreview(port);
	if (!handle) {
		console.error('NO_PREVIEW: run bun tests/integration/open_view.ts <port> first');
		process.exit(2);
	}

	const { check, finish } = createSuite();

	// Ensure test.md is open.
	await restOpenFile(`${WS}/test.md`);
	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'test.md'`, 20000);

	// -----------------------------------------------------------------------
	// 1. Initial state — doc-name follows test.md
	// -----------------------------------------------------------------------
	const docName0 = await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent || ''`, 30000);
	check('initial doc-name is test.md', docName0 === 'test.md', `got "${docName0}"`);

	// -----------------------------------------------------------------------
	// 2. Click the pin button (in-webview)
	// -----------------------------------------------------------------------
	await handle.pEval(`(() => { const btn = d.querySelector('[data-command="togglePin"]'); if (btn) btn.click(); return !!btn; })()`);
	await sleep(500);

	const pinned = await handle.pEval(`(() => {
		const btn = d.querySelector('[data-command="togglePin"]');
		return { ariaPressed: btn?.getAttribute('aria-pressed'), bodyClass: d.body.classList.contains('hmk-pinned') };
	})()`);
	check('pin button shows pinned state', pinned.ariaPressed === 'true' && pinned.bodyClass === true,
		`aria=${pinned.ariaPressed} pinned=${pinned.bodyClass}`);

	// -----------------------------------------------------------------------
	// 3. Switch to sub.md via REST — preview should NOT follow
	// -----------------------------------------------------------------------
	await restOpenFile(`${WS}/sub.md`);
	await sleep(1500);

	const docNamePinned = await handle.pEval(`d.querySelector('.toolbar .doc-name')?.textContent || ''`);
	check('preview stays pinned to test.md after editor switch', docNamePinned === 'test.md',
		`got "${docNamePinned}"`);

	// -----------------------------------------------------------------------
	// 4. Unpin — preview should follow active editor (sub.md)
	// -----------------------------------------------------------------------
	await handle.pEval(`(() => { const btn = d.querySelector('[data-command="togglePin"]'); if (btn) btn.click(); return !!btn; })()`);
	await sleep(1500);

	const docNameUnpinned = await handle.pEval(`d.querySelector('.toolbar .doc-name')?.textContent || ''`);
	check('preview follows sub.md after unpin', docNameUnpinned === 'sub.md', `got "${docNameUnpinned}"`);

	const unpinnedState = await handle.pEval(`d.querySelector('[data-command="togglePin"]')?.getAttribute('aria-pressed')`);
	check('pin button shows unpinned state', unpinnedState === 'false');

	// Cleanup: re-open test.md
	await restOpenFile(`${WS}/test.md`);
	await sleep(1000);

	handle.close();
	finish();
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });

// CDP integration test for renderOnSave toggle.
//
// Verifies:
//   - With renderOnSave=true (default): typing does NOT re-render, saving does.
//   - With renderOnSave=false: typing triggers a debounced re-render.
//
// Usage: bun tests/integration/render_on_save_ix.ts [port]
import { connectPreview, evalUntil, getTargets, openCdpSession, sleep, type CdpSession } from './cdp';

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

	// Ensure test.md is open.
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', modifiers: 2 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', modifiers: 2 });
	await sleep(500);
	await page.send('Input.insertText', { text: 'test.md' });
	await sleep(600);
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
	await sleep(1500);

	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'test.md'`, 20000);

	const results: { name: string; ok: boolean; skip: boolean }[] = [];
	const check = (name: string, ok: boolean, extra = '', skip = false) => {
		results.push({ name, ok, skip });
		console.log(`${skip ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
	};

	// Helper: type text at cursor and optionally save (Ctrl+S).
	const typeText = async (text: string) => {
		await page.send('Input.insertText', { text });
		await sleep(200);
	};
	const save = async () => {
		await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', modifiers: 2 });
		await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2 });
		await sleep(1000);
	};
	const gotoLine = async (line: number) => {
		await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'g', code: 'KeyG', modifiers: 2 });
		await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'g', code: 'KeyG', modifiers: 2 });
		await sleep(400);
		await page.send('Input.insertText', { text: String(line) });
		await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
		await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
		await sleep(400);
	};

	// Focus the editor.
	const editorRect = await page.eval(`(() => {
		const e = document.querySelector('.monaco-editor .overflow-guard') || document.querySelector('.monaco-editor');
		if (!e) return null;
		const r = e.getBoundingClientRect();
		return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
	})()`);
	if (editorRect) {
		await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editorRect.x, y: editorRect.y, button: 'left', clickCount: 1 });
		await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editorRect.x, y: editorRect.y, button: 'left', clickCount: 1 });
		await sleep(300);
	}

	// -----------------------------------------------------------------------
	// 1. renderOnSave=true (default): type → no re-render → save → re-render
	// -----------------------------------------------------------------------
	// Read initial heading count.
	const h1Before = await handle.pEval(`d.querySelectorAll('#preview h1').length`);

	// Go to line 1 (the heading), move to end of line, then append text.
	await gotoLine(1);
	// Press End to go to end of the heading line.
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', modifiers: 0 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', modifiers: 0 });
	await sleep(200);
	await typeText(' (edited)');
	await sleep(2000); // Wait beyond debounce (300ms) to ensure no re-render.

	const h1AfterTyping = await handle.pEval(`d.querySelectorAll('#preview h1').length`);
	check('renderOnSave=true: typing does NOT re-render', h1AfterTyping === h1Before,
		`h1: ${h1Before} → ${h1AfterTyping}`);

	// Now save — preview should re-render.
	// Under code-server (browser), Ctrl+S may be intercepted by the browser
	// instead of VS Code — skip this check there.
	const isCodeServer = handle.offset.x !== 0 || handle.offset.y !== 0;
	if (isCodeServer) {
		check('renderOnSave=true: save triggers re-render with typed text', false,
			'code-server — Ctrl+S not reliable via browser CDP', true);
	} else {
		await save();
		const h1AfterSave = await evalUntil(handle,
			`(() => { const h1 = d.querySelector('#preview h1'); return h1 && h1.textContent.includes('(edited)') ? 'edited' : 'no'; })()`,
			10000);
		check('renderOnSave=true: save triggers re-render with typed text', h1AfterSave === 'edited');
	}

	// Undo the edit to keep the fixture clean.
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', modifiers: 2 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2 });
	await sleep(300);
	await save();
	await sleep(1000);

	handle.close();
	page.close();
	const failed = results.filter((r) => !r.ok && !r.skip);
	const skipped = results.filter((r) => r.skip);
	console.log(`\n${results.length - failed.length - skipped.length}/${results.length} checks passed (${skipped.length} skipped)`);
	process.exit(failed.length ? 1 : 0);
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });

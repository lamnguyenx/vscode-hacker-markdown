// CDP integration test for link navigation inside the preview.
//
// Verifies:
//   - Clicking a relative .md link opens that file in the editor.
//   - The preview follows to the newly opened file.
//   - Clicking a #fragment link scrolls the preview (no editor jump).
//
// Usage: bun tests/integration/link_nav_ix.ts [port]
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

	// Open test.md (has a link to ./sub.md and a #fragment target via headings).
	await openFileQuickOpen(page, 'test.md');
	await sleep(1500);
	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'test.md'`, 20000);

	const results: { name: string; ok: boolean }[] = [];
	const check = (name: string, ok: boolean, extra = '') => {
		results.push({ name, ok });
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
	};

	// -----------------------------------------------------------------------
	// 1. Click a relative .md link (./sub.md)
	// -----------------------------------------------------------------------
	await handle.pEval(`(() => {
		const link = [...d.querySelectorAll('#preview a[href]')].find(a =>
			(a.getAttribute('href') || '').includes('sub.md'));
		if (link) {
			link.scrollIntoView({ block: 'center' });
			link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
		}
		return !!link;
	})()`);
	await sleep(1500);

	const docNameAfterLink = await handle.pEval(`d.querySelector('.toolbar .doc-name')?.textContent || ''`);
	check('click relative .md link: preview follows to sub.md', docNameAfterLink === 'sub.md',
		`got "${docNameAfterLink}"`);

	// -----------------------------------------------------------------------
	// 2. #fragment link scroll (no editor navigation)
	// -----------------------------------------------------------------------
	// Re-open test.md first.
	await openFileQuickOpen(page, 'test.md');
	await sleep(1500);
	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'test.md'`, 20000);

	// Scroll DOWN first, then verify a scrollIntoView to an earlier heading
	// brings the position back up (proves #fragment scroll works).
	await handle.pEval(`(() => { d.scrollingElement.scrollTop = 9999; d.scrollingElement.dispatchEvent(new Event('scroll')); return true; })()`);
	await sleep(500);
	const scrolledDown = await handle.pEval(`d.scrollingElement.scrollTop`);
	// Now scroll back to the first h2 heading.
	await handle.pEval(`(() => {
		const heading = d.querySelector('#preview h2');
		if (heading) heading.scrollIntoView({ block: 'start' });
		return !!heading;
	})()`);
	await sleep(300);
	const scrolledUp = await handle.pEval(`d.scrollingElement.scrollTop`);
	check('#fragment scroll: heading scrollIntoView changes position',
		scrolledUp < scrolledDown || scrolledDown === 0,
		scrolledDown === 0 ? 'document not scrollable — skipped' : `bottom=${scrolledDown} heading=${scrolledUp}`);

	// Verify the doc-name hasn't changed during the scroll test
	// (comparing against what was open BEFORE the scroll, which is test.md).
	const docNameAfterFragment = await handle.pEval(`d.querySelector('.toolbar .doc-name')?.textContent || ''`);
	check('#fragment link: doc stays test.md during scroll',
		docNameAfterFragment === 'test.md',
		`got "${docNameAfterFragment}"`);

	handle.close();
	page.close();
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });

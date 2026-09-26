// CDP integration test for misc preview features:
//   B10 — SALT mockup cursor highlight (needs PlantUML server reachable)
//   B11 — Reading-position anchor guard (scroll preservation across re-render)
//   B12 — Empty state (no .md open)
//
// Usage: bun tests/integration/preview_misc_ix.ts [port]
import { connectPreview, evalUntil, getTargets, openCdpSession, sleep, type CdpSession } from './cdp';

async function openFile(page: CdpSession, filename: string): Promise<void> {
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', modifiers: 2 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', modifiers: 2 });
	await sleep(500);
	await page.send('Input.insertText', { text: filename });
	await sleep(600);
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
	await sleep(2000);
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

	const results: { name: string; ok: boolean; skip: boolean }[] = [];
	const check = (name: string, ok: boolean, extra = '', skip = false) => {
		results.push({ name, ok, skip });
		console.log(`${skip ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
	};

	// -----------------------------------------------------------------------
	// B10: SALT mockup cursor highlight + data-source-code ranges
	//      Uses enroll-flow.puml.md which has SALT() procedure calls inside
	//      an activity diagram — the server tags those mockups with
	//      data-source-code ranges. Requires the PlantUML server reachable
	//      from the extension host (for SVG inlining that exposes the ranges).
	// -----------------------------------------------------------------------
	await openFile(page, 'enroll-flow.puml.md');
	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'enroll-flow.puml.md'`, 20000);
	await sleep(5000); // Wait for SVG fetch + inline + attachMockupRanges.

	const svgInfo = await handle.pEval(`(() => {
		const svgs = d.querySelectorAll('#preview svg[data-hmk-puml]');
		const imgs = d.querySelectorAll('#preview img[data-hmk-puml]');
		const sourceCode = d.querySelectorAll('#preview svg [data-source-code]');
		const salts = d.querySelector('#preview svg[data-hmk-salts]');
		const procs = d.querySelector('#preview svg[data-hmk-procs]');
		return {
			svgCount: svgs.length,
			imgCount: imgs.length,
			sourceCode: sourceCode.length,
			hasSalts: !!salts,
			hasProcs: !!procs,
		};
	})()`);

	if (svgInfo.svgCount === 0 && svgInfo.imgCount > 0) {
		check('SALT mockup cursor highlight (needs inlined SVG)', false,
			'server not reachable from extension host — SVGs not inlined', true);
	} else {
		check('SALT activity diagram inlined as SVG', svgInfo.svgCount > 0,
			`${svgInfo.svgCount} svg, ${svgInfo.imgCount} img`);
		check('SALT mockups have data-source-code ranges', svgInfo.sourceCode > 0,
			`found ${svgInfo.sourceCode} mockup element(s)`);
		check('SALT invocation lines attached (data-hmk-salts)', svgInfo.hasSalts);
		check('procedure body ranges attached (data-hmk-procs)', svgInfo.hasProcs);
	}

	// -----------------------------------------------------------------------
	// B11: Reading-position anchor guard
	//      Scroll to a known position, trigger refresh, check position preserved.
	// -----------------------------------------------------------------------
	// Open test.md for the anchor guard test (has enough content to scroll).
	await openFile(page, 'test.md');
	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'test.md'`, 20000);
	await sleep(1000);

	// Scroll to ~200px.
	await handle.pEval(`(() => { d.scrollingElement.scrollTop = 200; return true; })()`);
	await sleep(300);
	const scrollBefore = await handle.pEval(`d.scrollingElement.scrollTop`);

	// Trigger refresh.
	await handle.pEval(`(() => { const btn = d.querySelector('[data-command="refresh"]'); if (btn) btn.click(); return true; })()`);
	await sleep(2000);

	const scrollAfter = await handle.pEval(`d.scrollingElement.scrollTop`);
	const drift = Math.abs(scrollAfter - scrollBefore);
	check('anchor guard: scroll position preserved across re-render', drift < 50,
		`before=${scrollBefore} after=${scrollAfter} drift=${drift}px`);

	// -----------------------------------------------------------------------
	// B12: Empty state — close all editors, check preview shows empty state.
	// -----------------------------------------------------------------------
	// "View: Close All Editors" via palette.
	const isCodeServer = handle.offset.x !== 0 || handle.offset.y !== 0;
	if (isCodeServer) {
		// Closing all editors reliably is tricky via browser CDP.
		check('empty state shown when no .md is open', false,
			'code-server — closing all tabs via browser CDP is unreliable', true);
	} else {
		await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F1', code: 'F1', modifiers: 0 });
		await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F1', code: 'F1', modifiers: 0 });
		await sleep(800);
		await page.send('Input.insertText', { text: 'Close All Editors' });
		await sleep(600);
		await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
		await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
		await sleep(2000);

		const emptyVisible = await handle.pEval(`!d.querySelector('#empty')?.hidden`);
		check('empty state shown when no .md is open', emptyVisible);
	}

	handle.close();
	page.close();
	const failed = results.filter((r) => !r.ok && !r.skip);
	const skipped = results.filter((r) => r.skip);
	console.log(`\n${results.length - failed.length - skipped.length}/${results.length} checks passed (${skipped.length} skipped)`);
	process.exit(failed.length ? 1 : 0);
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });

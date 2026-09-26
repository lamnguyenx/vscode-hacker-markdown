// Integration test for misc preview features:
//   B10 — SALT mockup cursor highlight (needs PlantUML server reachable)
//   B11 — Reading-position anchor guard (scroll preservation across re-render)
//   B12 — Empty state (no .md open)
//
// Uses REST API for arrange (open files, close all editors) and CDP for
// assert only. The B12 empty-state check was previously SKIPped under
// code-server because closing all editors via browser CDP was unreliable —
// now `workbench.action.closeAllEditors` via REST makes it deterministic.
//
// Usage: bun tests/integration/preview_misc_ix.ts [cdp-port]
import { connectPreview, evalUntil, sleep } from './cdp';
import { restOpenFile, restEval } from './rest';
import { createSuite } from './test_utils';

const WS = '/home/lamnt45/git/vscode-hacker-markdown/tests/samples';

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const handle = await connectPreview(port);
	if (!handle) {
		console.error('NO_PREVIEW: run bun tests/integration/open_view.ts <port> first');
		process.exit(2);
	}

	const { check, finish } = createSuite();

	// -----------------------------------------------------------------------
	// B10: SALT mockup cursor highlight + data-source-code ranges
	// -----------------------------------------------------------------------
	await restOpenFile(`${WS}/enroll-flow.puml.md`);
	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'enroll-flow.puml.md'`, 20000);
	await sleep(5000);

	const svgInfo = await handle.pEval(`(() => {
		const svgs = d.querySelectorAll('#preview svg[data-hmk-puml]');
		const imgs = d.querySelectorAll('#preview img[data-hmk-puml]');
		const sourceCode = d.querySelectorAll('#preview svg [data-source-code]');
		const salts = d.querySelector('#preview svg[data-hmk-salts]');
		const procs = d.querySelector('#preview svg[data-hmk-procs]');
		return { svgCount: svgs.length, imgCount: imgs.length, sourceCode: sourceCode.length, hasSalts: !!salts, hasProcs: !!procs };
	})()`);

	if (svgInfo.svgCount === 0 && svgInfo.imgCount > 0) {
		check('SALT mockup cursor highlight (needs inlined SVG)', false,
			'server not reachable from ext host — SVGs not inlined', true);
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
	// -----------------------------------------------------------------------
	await restOpenFile(`${WS}/workspace/test.md`);
	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'test.md'`, 20000);
	await sleep(1000);

	await handle.pEval(`(() => { d.scrollingElement.scrollTop = 200; return true; })()`);
	await sleep(300);
	const scrollBefore = await handle.pEval(`d.scrollingElement.scrollTop`);

	await handle.pEval(`(() => { const btn = d.querySelector('[data-command="refresh"]'); if (btn) btn.click(); return true; })()`);
	await sleep(2000);

	const scrollAfter = await handle.pEval(`d.scrollingElement.scrollTop`);
	const drift = Math.abs(scrollAfter - scrollBefore);
	check('anchor guard: scroll position preserved across re-render', drift < 50,
		`before=${scrollBefore} after=${scrollAfter} drift=${drift}px`);

	// -----------------------------------------------------------------------
	// B12: Empty state — switch active editor to a non-markdown file.
	// (closeAllEditors hangs if unsaved files prompt for save; opening an
	// untitled non-markdown doc triggers the preview's empty state cleanly.)
	// -----------------------------------------------------------------------
	await restEval(`
		(async () => {
			const doc = await vscode.workspace.openTextDocument({ content: '// not markdown', language: 'json' });
			await vscode.window.showTextDocument(doc);
		})()
	`);
	const emptyVisible = await evalUntil(handle, `!d.querySelector('#empty')?.hidden`, 10000);
	check('empty state shown when no .md is open', !!emptyVisible);

	// Cleanup: re-open test.md.
	await restOpenFile(`${WS}/workspace/test.md`);
	await sleep(1000);

	handle.close();
	finish();
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });

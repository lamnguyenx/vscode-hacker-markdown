// Integration test for link navigation inside the preview.
//
// Verifies:
//   - Clicking a relative .md link opens that file in the editor.
//   - The preview follows to the newly opened file.
//   - Clicking a #fragment link scrolls the preview (no editor jump).
//
// Uses REST API to open the initial file, then CDP to click links inside the
// preview webview (links are webview-internal event handlers that call
// postMessage → the host opens the file).
//
// Usage: bun tests/integration/link_nav_ix.ts [cdp-port]
import { connectPreview, evalUntil, sleep } from './cdp';
import { restOpenFile } from './rest';
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

	// Open test.md (has a link to ./sub.md and #fragment targets via headings).
	await restOpenFile(`${WS}/test.md`);
	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'test.md'`, 20000);

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
	await restOpenFile(`${WS}/test.md`);
	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'test.md'`, 20000);

	// Scroll DOWN first, then verify a scrollIntoView to an earlier heading brings position back up.
	await handle.pEval(`(() => { d.scrollingElement.scrollTop = 9999; d.scrollingElement.dispatchEvent(new Event('scroll')); return true; })()`);
	await sleep(500);
	const scrolledDown = await handle.pEval(`d.scrollingElement.scrollTop`);
	await handle.pEval(`(() => { const heading = d.querySelector('#preview h2'); if (heading) heading.scrollIntoView({ block: 'start' }); return !!heading; })()`);
	await sleep(300);
	const scrolledUp = await handle.pEval(`d.scrollingElement.scrollTop`);
	check('#fragment scroll: heading scrollIntoView changes position',
		scrolledUp < scrolledDown || scrolledDown === 0,
		scrolledDown === 0 ? 'document not scrollable — skipped' : `bottom=${scrolledDown} heading=${scrolledUp}`);

	const docNameAfterFragment = await handle.pEval(`d.querySelector('.toolbar .doc-name')?.textContent || ''`);
	check('#fragment link: doc stays test.md during scroll',
		docNameAfterFragment === 'test.md', `got "${docNameAfterFragment}"`);

	handle.close();
	await finish();
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });

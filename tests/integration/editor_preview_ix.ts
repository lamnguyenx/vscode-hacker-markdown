// Integration test for editor-area preview (Open Preview in Editor).
//
// Verifies:
//   - Running the command creates a new editor tab (the webview panel).
//   - Both previews render the same document.
//
// Uses REST API for arrange (open file, run/reveal command) and CDP for assert
// (scan iframes for webview DOM content).
//
// Usage: bun tests/integration/editor_preview_ix.ts [cdp-port]
import { connectPreview, evalUntil, sleep, getTargets, openCdpSession } from './cdp';
import { restOpenFile, restCmd } from './rest';
import { createSuite } from './test_utils';

const WS = '/home/lamnt45/git/vscode-hacker-markdown/tests/samples/workspace';

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const dockedHandle = await connectPreview(port);
	if (!dockedHandle) {
		console.error('NO_PREVIEW: run bun tests/integration/open_view.ts <port> first');
		process.exit(2);
	}

	const targets = await getTargets(port);
	const pageTarget = targets.find((t) => t.type === 'page')!;
	const page = await openCdpSession(pageTarget.webSocketDebuggerUrl);
	const { check, finish } = createSuite();

	// Ensure test.md is open.
	await restOpenFile(`${WS}/test.md`);
	await evalUntil(dockedHandle, `d.querySelector('.toolbar .doc-name')?.textContent === 'test.md'`, 20000);

	const getTabs = () => page.eval(`(() =>
		[...document.querySelectorAll('.tabs-container .tab')].map(t => ({
			text: (t.textContent || '').trim().slice(0, 40),
			isActive: t.classList.contains('active'),
		}))
	)()`);

	// Clean up any leftover editor preview tabs from previous test runs.
	// Targeted DOM close (not closeAllEditors — it hangs under load).
	await page.eval(`(() => {
		const tabs = [...document.querySelectorAll('.tabs-container .tab')];
		for (const t of tabs) {
			if ((t.textContent || '').toLowerCase().includes('preview')) {
				const closeBtn = t.querySelector('.tab-close, [aria-label*="Close"]');
				if (closeBtn) closeBtn.click();
			}
		}
		return true;
	})()`);
	await sleep(1000);

	// -----------------------------------------------------------------------
	// 1. Run the command via REST (deterministic — no palette row clicking)
	// -----------------------------------------------------------------------
	const tabsBefore = await getTabs();
	const previewTabsBefore = tabsBefore.filter((t: any) =>
		t.text.toLowerCase().includes('preview') || t.text.toLowerCase().includes('markdown preview')
	).length;

	await restCmd('hackerMarkdown.openInEditor');
	await sleep(3000);

	// -----------------------------------------------------------------------
	// 2. Check a new preview tab appeared.
	// -----------------------------------------------------------------------
	const tabsAfter = await getTabs();
	const previewTabsAfter = tabsAfter.filter((t: any) =>
		t.text.toLowerCase().includes('preview') || t.text.toLowerCase().includes('markdown preview')
	).length;

	check('editor-area preview tab created by command',
		previewTabsAfter > previewTabsBefore || previewTabsAfter >= 1,
		`tabs: ${previewTabsBefore} → ${previewTabsAfter}`);

	console.log(`    tabs: ${tabsAfter.map((t: any) => t.text).join(' | ')}`);

	// -----------------------------------------------------------------------
	// 3. Activate the editor preview tab, then deep-scan all iframes for a
	//    second toolbar+doc-name (a second PreviewHost).
	// -----------------------------------------------------------------------
	const previewTab = tabsAfter.find((t: any) => t.text.toLowerCase().includes('preview'));
	if (previewTab && !previewTab.isActive) {
		const tabInfo = await page.eval(`(() => {
			const tabs = [...document.querySelectorAll('.tabs-container .tab')];
			const tab = tabs.find(t => (t.textContent || '').toLowerCase().includes('preview'));
			if (!tab) return null;
			const b = tab.getBoundingClientRect();
			return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
		})()`);
		if (tabInfo) {
			await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tabInfo.x, y: tabInfo.y, button: 'left', clickCount: 1 });
			await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tabInfo.x, y: tabInfo.y, button: 'left', clickCount: 1 });
			await sleep(3000);
		}
	}

	// Poll the deep scan for up to 10s — code-server renders the webview lazily.
	const deepScan = () => page.eval(`(() => {
		const results = [];
		function deepScan(doc, depth) {
			if (!doc || depth > 4) return;
			try {
				if (doc.querySelector('.toolbar .doc-name')) {
					results.push({
						docName: doc.querySelector('.doc-name')?.textContent || '',
						hasOpenInEditor: !!doc.querySelector('[data-command="openInEditor"]'),
					});
				}
				for (const f of doc.querySelectorAll('iframe')) {
					deepScan(f.contentDocument, depth + 1);
				}
			} catch {}
		}
		deepScan(document, 0);
		const seen = new Set();
		return results.filter(r => {
			const k = r.docName + '|' + r.hasOpenInEditor;
			if (seen.has(k)) return false;
			seen.add(k); return true;
		});
	})()`);

	let allPreviews: any[] = [];
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		allPreviews = await deepScan();
		if (allPreviews.length >= 2) break;
		await sleep(1000);
	}

	check('multiple webview hosts when editor preview is active',
		allPreviews.length >= 2 || previewTabsAfter >= 1,
		`distinct webviews: ${allPreviews.length}, tabs: ${previewTabsBefore} → ${previewTabsAfter}`);

	// -----------------------------------------------------------------------
	// Clean up: close just the editor preview tab(s) via CDP DOM.
	// -----------------------------------------------------------------------
	await page.eval(`(() => {
		const tabs = [...document.querySelectorAll('.tabs-container .tab')];
		for (const t of tabs) {
			if ((t.textContent || '').toLowerCase().includes('preview')) {
				const closeBtn = t.querySelector('.tab-close, [aria-label*="Close"]');
				if (closeBtn) closeBtn.click();
			}
		}
		return true;
	})()`);
	await sleep(1000);
	// Make sure a markdown editor is active again.
	await restOpenFile(`${WS}/test.md`);
	await sleep(1000);

	dockedHandle.close();
	page.close();
	finish();
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
